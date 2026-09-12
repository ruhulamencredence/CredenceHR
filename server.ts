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
import { syncAllZkDevices, syncZkDevice, startZkSyncSchedule } from "./zkSync";
import { registerProfileRoutes } from "./profileRoutes";
import { registerHolidayRoutes, ensureHolidayCalendarSchema, getHolidayMap } from "./holidayRoutes";
import { registerAlertRoutes, ensureAlertsSchema, createAlert } from "./Alerts";
import { registerUserManagementRoutes } from "./UserManagement";
import { registerConveyanceBillClaimRoutes } from "./ConveyanceBillClaimRoutes";
import { registerDepartmentsAndBranchesRoutes } from "./DepartmentsAndBranches";
import { registerAttendanceRoutes } from "./AttendanceRoutes";
import { registerApprovalRoutes } from "./ApprovalRoutes";
import { registerLeaveRoutes } from "./LeaveRoutes";
import { registerPayrollRoutes, ensurePayrollSchema } from "./PayrollRoutes";

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
function todayInDhaka(): string {
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
let isMySQLConnected = false;

// In-Memory Fallback DB storage when MySQL is not running (no demo data — admin is seeded from .env at startup)
const memoryDb = {
  users: [] as any[],
  projects: [] as any[],
  mpr_numbers: [] as any[],
  jobs: [] as any[],
  entries: [] as any[],
  budgets: [] as any[],
  budget_items: [] as any[],
  budget_submissions: [] as any[],
  user_project_permissions: [] as any[],
  entry_edit_history: [] as any[],
  rate_list: [] as any[],
  material_categories: [] as any[],
  rate_file_meta: null as any,
  adminModulePermissions: [] as any[],
  attendance: [] as any[],
  location_pings: [] as any[],
  notices: [] as any[],
  noticeTargets: [] as any[],
  noticeDismissals: [] as any[],
  employees: [] as any[],
  employeeSupervisors: [] as any[],
  claims: [] as any[],
  approvalChainSteps: [] as any[],
  approvalRequests: [] as any[],
  leaveBalances: [] as any[],
  leaveApplications: [] as any[]
};

async function initDB() {
  try {
    dbPool = mysql.createPool({
      host: process.env.DB_HOST || "localhost",
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME || "mpr_tracker_db",
      port: Number(process.env.DB_PORT) || 3306,
      waitForConnections: true,
      connectionLimit: 10,
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
    await ensureSchemaMigrations();
    startZkSyncSchedule(dbPool);
  } catch (err: any) {
    console.warn("⚠️ MySQL Connection failed (" + err.message + "). Falling back to in-memory storage for preview/testing. (To use MySQL, ensure XAMPP MySQL is running and .env is configured).");
    isMySQLConnected = false;
  }
}

// Self-healing migrations for tables added AFTER the original schema.sql was written.
// Anyone who imported schema.sql before this table existed (an already-running,
// pre-existing database) would otherwise hit "Table doesn't exist" the first time this
// feature is used — CREATE TABLE IF NOT EXISTS here means a normal server restart is
// enough to pick it up, no manual SQL required.
async function ensureSchemaMigrations() {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS budget_submissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        budget_id INT NOT NULL,
        user_id INT NOT NULL,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_budget_user (budget_id, user_id),
        FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure budget_submissions table exists: " + err.message);
  }

  // Global Calendar (Weekend/Holiday) — table + schema owned by holidayRoutes.ts,
  // only the call site lives here, same as every other self-healing migration
  // in this function.
  await ensureHolidayCalendarSchema(dbPool);

  // Personal Alerts (bell icon, web + mobile) — table + schema owned by
  // Alerts.ts, only the call site lives here, same as every other
  // self-healing migration in this function.
  await ensureAlertsSchema(dbPool);

  // Payroll Module (salary_structures / employee_advances / payrolls) —
  // table + schema owned by PayrollRoutes.ts, only the call site lives here,
  // same as every other self-healing migration in this function.
  await ensurePayrollSchema(dbPool);

  // Personal Data (ProfilePage.tsx -> PersonalDataForm.tsx) — one row per user,
  // created on first save. Position/Department are deliberately NOT columns
  // here — they're read live from all_employees (via all_employees.user_id)
  // by profileRoutes.ts instead, so the Employees module stays the single
  // source of truth for both. Same self-healing pattern as the other tables
  // in this function.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS user_profile_details (
        user_id INT PRIMARY KEY,
        first_name VARCHAR(150) NULL,
        last_name VARCHAR(150) NULL,
        date_of_birth DATE NULL,
        country VARCHAR(100) NULL,
        state VARCHAR(100) NULL,
        city VARCHAR(100) NULL,
        full_address TEXT NULL,
        photo_mimetype VARCHAR(150) NULL,
        photo_data LONGBLOB NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure user_profile_details table exists: " + err.message);
  }

  // Entry edit history audit table — same self-healing pattern as budget_submissions
  // above, so an already-running database picks it up on next restart automatically.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS entry_edit_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        entry_id INT NOT NULL,
        edited_by INT,
        field_name VARCHAR(50) NOT NULL,
        old_value VARCHAR(255),
        new_value VARCHAR(255),
        edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
        FOREIGN KEY (edited_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure entry_edit_history table exists: " + err.message);
  }

  // Self-healing column additions for the Admin-set Delivery Date window feature —
  // ignore the error if the column already exists (older MySQL doesn't support
  // "ADD COLUMN IF NOT EXISTS" reliably, so this is the portable approach).
  try {
    await dbPool.query(`ALTER TABLE budgets ADD COLUMN delivery_date_from DATE DEFAULT NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add budgets.delivery_date_from column: " + err.message);
    }
  }
  try {
    await dbPool.query(`ALTER TABLE budgets ADD COLUMN delivery_date_to DATE DEFAULT NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add budgets.delivery_date_to column: " + err.message);
    }
  }

  // Self-healing column additions for the "Job Recycle" soft-delete feature — Users
  // can delete their own (unlocked) entries, but a delete only sets deleted_at /
  // deleted_by instead of erasing the row, so the Admin can review + restore it from
  // the Recycle bin. Ignore the error if the column already exists.
  try {
    await dbPool.query(`ALTER TABLE entries ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add entries.deleted_at column: " + err.message);
    }
  }
  try {
    await dbPool.query(`ALTER TABLE entries ADD COLUMN deleted_by INT NULL DEFAULT NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add entries.deleted_by column: " + err.message);
    }
  }

  // entries.item_name must be able to hold the full imported budget_items.description
  // (VARCHAR(255)) it's matched against in GET /api/entries — an older, shorter column
  // here silently truncates long item names on insert, which then never matches the
  // Description in budget_items, so Specification/Req. Qty/etc. show blank in Job
  // Entry Details for those rows. Widen it on every startup so this self-heals on an
  // existing database too, not just fresh installs from schema.sql.
  try {
    await dbPool.query(`ALTER TABLE entries MODIFY COLUMN item_name VARCHAR(255) NOT NULL`);
  } catch (err: any) {
    console.warn("⚠️ Could not widen entries.item_name column: " + err.message);
  }

  // Self-healing column addition: pins each entry to the EXACT imported Budget Excel
  // row (budget_items.id) its Item Name came from, instead of only being matched back
  // to it by description text. Multiple Excel rows under the same MRF No can share the
  // exact same "Description of Materials" text (different Qty/Specification/Sl.No.) —
  // without this column those were indistinguishable, so entry creation collapsed them
  // down to one entry per unique description instead of one entry per Excel row.
  try {
    await dbPool.query(`ALTER TABLE entries ADD COLUMN budget_item_id INT NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add entries.budget_item_id column: " + err.message);
    }
  }

  // Rate/Amount/Category columns — filled in by POST /api/budgets/:id/approve, which
  // matches each entry's Item Name (+ Specification) against the Rate File's "Rate" and
  // "Materials Category" sheets. NULL means "not yet approved" or "no match found"
  // (distinguished by rate_calculated_at: NULL there means never attempted, NOT NULL
  // with matched_rate still NULL means it WAS attempted but genuinely has no match —
  // i.e. belongs in the Admin's Missing Rate / Missing Category review list).
  const entryRateColumns: [string, string][] = [
    ["matched_rate", "DECIMAL(14,2) NULL"],
    ["computed_amount", "DECIMAL(16,2) NULL"],
    ["category_head", "VARCHAR(150) NULL"],
    ["category_sub1", "VARCHAR(150) NULL"],
    ["category_sub2", "VARCHAR(150) NULL"],
    ["category_sub3", "VARCHAR(150) NULL"],
    ["category_sector", "VARCHAR(100) NULL"],
    ["rate_calculated_at", "TIMESTAMP NULL DEFAULT NULL"]
  ];
  for (const [col, def] of entryRateColumns) {
    try {
      await dbPool.query(`ALTER TABLE entries ADD COLUMN ${col} ${def}`);
    } catch (err: any) {
      if (err.code !== "ER_DUP_FIELDNAME") {
        console.warn(`⚠️ Could not add entries.${col} column: ` + err.message);
      }
    }
  }

  // Tracks the Admin's "Approve & Calculate" action per Budget (who ran it, when) —
  // shown in the Budget list so the Admin can see which Budgets still need it / were
  // last recalculated when.
  try {
    await dbPool.query(`ALTER TABLE budgets ADD COLUMN rate_approved_at TIMESTAMP NULL DEFAULT NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add budgets.rate_approved_at column: " + err.message);
    }
  }
  try {
    await dbPool.query(`ALTER TABLE budgets ADD COLUMN rate_approved_by INT NULL DEFAULT NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add budgets.rate_approved_by column: " + err.message);
    }
  }

  // Self-healing column addition: per-entry editable Requisitioned Qty, so a User can
  // split one Item's total Qty across several entries (each with its own Delivery
  // Date) instead of always requisitioning the whole thing in one entry. Capped
  // server-side in POST/PUT /api/entries against budget_items.req_qty.
  try {
    await dbPool.query(`ALTER TABLE entries ADD COLUMN requisitioned_qty DECIMAL(14,2) NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add entries.requisitioned_qty column: " + err.message);
    }
  }

  // "Submit" (publish) gate for the Admin's Import Rate File / Import Budget from
  // Excel workflow — a freshly created/imported Budget starts hidden from Users
  // (is_published = FALSE) until the Admin reviews it and clicks "Submit" on the
  // System Management & Reports → Data Import page. GET /api/budgets filters
  // unpublished Budgets out for non-admin callers so Users simply never see a Budget
  // that hasn't been submitted yet.
  try {
    await dbPool.query(`ALTER TABLE budgets ADD COLUMN is_published TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add budgets.is_published column: " + err.message);
    }
  }
  try {
    await dbPool.query(`ALTER TABLE budgets ADD COLUMN published_at TIMESTAMP NULL DEFAULT NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add budgets.published_at column: " + err.message);
    }
  }

  // Bulk User Import (Admin Panel -> Users -> Bulk Add Users): these users log in
  // with a Project Name (no email) + Password, so users.username stores that login
  // ID (the Project Name with all spaces stripped + lowercased). email is relaxed to
  // nullable since bulk-created users never get one. See POST /api/users/bulk and the
  // updated POST /api/auth/login below.
  try {
    await dbPool.query(`ALTER TABLE users ADD COLUMN username VARCHAR(150) NULL UNIQUE AFTER email`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add users.username column: " + err.message);
    }
  }
  try {
    await dbPool.query(`ALTER TABLE users MODIFY COLUMN email VARCHAR(150) NULL`);
  } catch (err: any) {
    console.warn("⚠️ Could not relax users.email to nullable: " + err.message);
  }
  try {
    // Login-location capture: only the latest login's coordinates are kept
    // (overwritten each login), not a history table. See POST /api/auth/login.
    await dbPool.query(`ALTER TABLE users ADD COLUMN last_login_lat DECIMAL(10, 7) NULL`);
    await dbPool.query(`ALTER TABLE users ADD COLUMN last_login_lng DECIMAL(10, 7) NULL`);
    await dbPool.query(`ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP NULL`);
  } catch (err: any) {
    console.warn("⚠️ Could not add users.last_login_lat/lng/at columns: " + err.message);
  }
  try {
    // Feature permissions (Admin Panel -> Users). Defaults match schema.sql: delivery
    // date edit ON for everyone, Job Edit OFF until an Admin turns it on per user.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_edit_delivery_date TINYINT(1) NOT NULL DEFAULT 1`);
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_job_edit TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    // Column already exists — safe to ignore on every server restart after the first.
  }
  try {
    // Gate for the Remote Attendance Check In/Out card on a plain User's own
    // Dashboard (User Panel) — OFF by default; an Admin/Superadmin must grant
    // it per account (Admin Panel -> Users -> Feature Permissions), same
    // pattern as can_job_edit above. This is separate from the "attendance"
    // Admin Panel module (admin_module_permissions), which is about an
    // Admin/User REVIEWING everyone else's attendance records, not their own
    // ability to check in/out.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_use_attendance TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    // Column already exists — safe to ignore on every server restart after the first.
  }
  try {
    // Superadmin-only grant: lets a plain Admin see the "Last Login Location" column
    // in Admin Panel -> Users. OFF by default; a Superadmin always sees it regardless.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_view_login_location TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    console.warn("⚠️ Could not add users.can_view_login_location column: " + err.message);
  }
  try {
    // Superadmin-only grant: lets a plain Admin ALSO use the User Panel (mark
    // Remote Attendance, submit Claims/Conveyance Bills, enter Job/MPR data) on top
    // of their normal Admin Panel — the same on/off switch pattern as
    // can_view_login_location above. OFF by default; only ever meaningful for
    // role='admin' (a plain 'user' already has this by definition, a Superadmin's
    // own account is never granted it — see PUT /api/users/:id/user-panel-access).
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_access_user_panel TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    console.warn("⚠️ Could not add users.can_access_user_panel column: " + err.message);
  }
  try {
    // Superadmin-only grant: lets an Admin or User account ALSO edit other
    // accounts' Leave balances on Self Service -> Leave Management (see the
    // leave_balances table below) — same on/off switch pattern as
    // can_access_user_panel above, but (unlike that one) applies to BOTH 'admin'
    // and 'user' roles. OFF by default; a Superadmin always has this implicitly.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_manage_leave TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    console.warn("⚠️ Could not add users.can_manage_leave column: " + err.message);
  }
  try {
    // Superadmin-only grants: whether this Admin or User account can see/use the
    // Movement Claim (GPS Check In/Out) and Conveyance Bill Claim sections on their
    // own User Panel at all — same on/off pattern as can_manage_leave above, gated
    // for BOTH 'admin' and 'user' roles. OFF by default; a Superadmin always has
    // both implicitly.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_view_movement_claims TINYINT(1) NOT NULL DEFAULT 0`);
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_view_conveyance_claims TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    console.warn("⚠️ Could not add users.can_view_movement_claims/can_view_conveyance_claims columns: " + err.message);
  }
  try {
    // Gate for the mobile app's background Employee Tracking ping loop — OFF by
    // default; an Admin/Superadmin must grant it per account (Admin Panel -> Users
    // -> Feature Permissions), same pattern as can_use_attendance above. Separate
    // from the "tracking" Admin Panel module (admin_module_permissions), which is
    // about VIEWING everyone's live location, not this account's own device
    // reporting its location.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_use_tracking TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    // Column already exists — safe to ignore on every server restart after the first.
  }
  try {
    // Superadmin-only grant: whether this Admin or User account can see/use the
    // core MPR entry workflow on their own User Panel — "Select a Budget", "Jobs"
    // and "Job Entry Details" (the mobile tile menu's three main tiles, the
    // Navbar/GlobalSidebar "Jobs" menu's Entry/Jobs/Entry Details items, and the
    // BottomNav's Budget/Jobs/Entries tabs). One combined switch for all three,
    // same on/off pattern as can_view_movement_claims/can_view_conveyance_claims
    // above, applying to BOTH 'admin' and 'user' roles. ON by default (unlike
    // those two) so every existing account keeps today's behavior until a
    // Superadmin explicitly turns it off; a Superadmin always has it implicitly.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_view_budget_module TINYINT(1) NOT NULL DEFAULT 1`);
  } catch (err: any) {
    console.warn("⚠️ Could not add users.can_view_budget_module column: " + err.message);
  }
  try {
    // Admin/Superadmin-granted per account (Admin Panel -> Users -> Leave):
    // shows the Leave Summary card on THIS account's own Dashboard. Always
    // true for role === 'superadmin'. OFF by default for 'admin'/'user' —
    // same toggle pattern as can_use_attendance/can_use_tracking above.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_view_leave_summary TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    console.warn("⚠️ Could not add users.can_view_leave_summary column: " + err.message);
  }
  try {
    // Project location pin (Admin Panel -> Projects -> "Set Location on Map"), a
    // free OpenStreetMap/Leaflet picker — no paid maps API key required.
    await dbPool.query(`ALTER TABLE projects ADD COLUMN location_lat DECIMAL(10, 7) NULL`);
    await dbPool.query(`ALTER TABLE projects ADD COLUMN location_lng DECIMAL(10, 7) NULL`);
    await dbPool.query(`ALTER TABLE projects ADD COLUMN location_label VARCHAR(255) NULL`);
  } catch (err: any) {
    console.warn("⚠️ Could not add projects.location_lat/lng/label columns: " + err.message);
  }
  try {
    // Optional site-radius circle (meters) drawn around the project's pin in the
    // map picker — e.g. to mark the approximate boundary of a site.
    await dbPool.query(`ALTER TABLE projects ADD COLUMN location_radius INT NULL`);
  } catch (err: any) {
    console.warn("⚠️ Could not add projects.location_radius column: " + err.message);
  }

  // Job No is scoped PER USER PER BUDGET instead of system-wide (each user's own
  // submissions start again from JOB-0001 independently of everyone else's, AND start
  // again from JOB-0001 whenever they switch to a different Budget) — self-heal an
  // existing database onto the new (created_by, budget_id, job_no) shape:
  // 1. Add the created_by column if it isn't there yet.
  try {
    await dbPool.query(`ALTER TABLE jobs ADD COLUMN created_by INT NULL DEFAULT NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add jobs.created_by column: " + err.message);
    }
  }
  // 1b. Add the budget_id column if it isn't there yet.
  try {
    await dbPool.query(`ALTER TABLE jobs ADD COLUMN budget_id INT NULL DEFAULT NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add jobs.budget_id column: " + err.message);
    }
  }
  // 2. Drop the old global UNIQUE on job_no alone (it blocks two different users from
  // ever both having a "JOB-0001") — the index is named "job_no" by default when
  // declared inline as `job_no VARCHAR(100) UNIQUE NOT NULL` in the original schema.
  try {
    await dbPool.query(`ALTER TABLE jobs DROP INDEX job_no`);
  } catch (err: any) {
    if (err.code !== "ER_CANT_DROP_FIELD_OR_KEY") {
      console.warn("⚠️ Could not drop old jobs.job_no unique index: " + err.message);
    }
  }
  // 2b. Drop the previous (created_by, job_no) composite unique key too — it's being
  // replaced by (created_by, budget_id, job_no) below.
  try {
    await dbPool.query(`ALTER TABLE jobs DROP INDEX unique_user_job_no`);
  } catch (err: any) {
    if (err.code !== "ER_CANT_DROP_FIELD_OR_KEY") {
      console.warn("⚠️ Could not drop old jobs.unique_user_job_no key: " + err.message);
    }
  }
  // 3. Add the new composite UNIQUE (created_by, budget_id, job_no) so uniqueness is
  // enforced per user PER BUDGET instead of per user system-wide.
  try {
    await dbPool.query(`ALTER TABLE jobs ADD UNIQUE KEY unique_user_budget_job_no (created_by, budget_id, job_no)`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_KEYNAME") {
      console.warn("⚠️ Could not add jobs.unique_user_budget_job_no key: " + err.message);
    }
  }
  // 3b. Add a FOREIGN KEY on jobs.budget_id (older DBs upgraded via ALTER above won't
  // have it from the CREATE TABLE definition).
  try {
    await dbPool.query(`ALTER TABLE jobs ADD FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE SET NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_KEYNAME" && err.code !== "ER_FK_DUP_NAME") {
      console.warn("⚠️ Could not add jobs.budget_id foreign key: " + err.message);
    }
  }

  // Rate File reference data (imported wholesale from an Admin-uploaded Excel with two
  // sheets: "Rate" — a materials price list — and "Materials Category" — a Head /
  // Sub-1 / Sub-2 / Sub-3 classification tree. Both are plain reference/lookup tables,
  // fully replaced on every re-import rather than merged, since they're always
  // re-uploaded as a complete sheet from a source-of-truth Excel file, not edited
  // row-by-row in the app.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS rate_list (
        id INT AUTO_INCREMENT PRIMARY KEY,
        materials_name VARCHAR(255) NOT NULL,
        unit VARCHAR(50) NULL,
        rate DECIMAL(14,2) NULL,
        specification VARCHAR(255) NULL,
        assigned_person VARCHAR(150) NULL,
        remarks VARCHAR(255) NULL,
        -- TRUE for a rate the Admin typed in directly (Approve & Calculate -> "No rate
        -- match" -> manual entry) instead of one that came from the imported Excel.
        -- Re-importing the Rate File only replaces is_manual = FALSE rows (see
        -- POST /api/rate-file/import), so a manually-entered rate survives future
        -- re-imports instead of silently disappearing until the Admin remembers to
        -- also add it to the Excel.
        is_manual TINYINT(1) NOT NULL DEFAULT 0,
        added_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure rate_list table exists: " + err.message);
  }
  try {
    await dbPool.query(`ALTER TABLE rate_list ADD COLUMN is_manual TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add rate_list.is_manual column: " + err.message);
    }
  }
  try {
    await dbPool.query(`ALTER TABLE rate_list ADD COLUMN added_by INT NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add rate_list.added_by column: " + err.message);
    }
  }
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS material_categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sl_no INT NULL,
        head VARCHAR(150) NULL,
        sub1 VARCHAR(150) NULL,
        sub2 VARCHAR(150) NULL,
        sub3 VARCHAR(150) NULL,
        details VARCHAR(255) NULL,
        sector VARCHAR(100) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure material_categories table exists: " + err.message);
  }
  // Single-row table (id is always 1) holding the original uploaded Rate File itself,
  // same "keep the source file, not just the parsed rows" approach as budgets.file_data.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS rate_file_meta (
        id INT PRIMARY KEY,
        original_filename VARCHAR(255) NULL,
        file_mimetype VARCHAR(150) NULL,
        file_data LONGBLOB NULL,
        imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure rate_file_meta table exists: " + err.message);
  }
  // Superadmin role: widen the users.role ENUM so a 'superadmin' account can be
  // seeded (see seedAdminFromEnv). Safe to re-run — MySQL just re-declares the
  // same ENUM if it's already there.
  try {
    await dbPool.query(`ALTER TABLE users MODIFY COLUMN role ENUM('superadmin','admin','user') DEFAULT 'user'`);
  } catch (err: any) {
    console.warn("⚠️ Could not widen users.role ENUM to include superadmin: " + err.message);
  }
  // Per-Admin module access, set by the Superadmin (Admin Panel -> Users -> Module
  // Access). Which Admin Panel tabs ('projects','mprs','imports','reports','users',
  // 'recycle','editlog') an Admin account may open.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS admin_module_permissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        module_key VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user_module (user_id, module_key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure admin_module_permissions table exists: " + err.message);
  }
  // "Remote Attendance" — one row per (user, project, calendar day). check_in_* is
  // filled when the User taps Check In (server-validated to be inside the Project's
  // location_radius circle around location_lat/location_lng); check_out_* likewise
  // when they later tap Check Out the same day. Distances are stored so the
  // Superadmin's Remote Attendance report can show exactly how far the check-in/out
  // was from the site, not just pass/fail.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        project_id INT NOT NULL,
        attendance_date DATE NOT NULL,
        check_in_at TIMESTAMP NULL DEFAULT NULL,
        check_in_lat DECIMAL(10, 7) NULL,
        check_in_lng DECIMAL(10, 7) NULL,
        check_in_distance_m INT NULL,
        check_out_at TIMESTAMP NULL DEFAULT NULL,
        check_out_lat DECIMAL(10, 7) NULL,
        check_out_lng DECIMAL(10, 7) NULL,
        check_out_distance_m INT NULL,
        check_in_remarks TEXT NULL,
        check_out_remarks TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user_project_date (user_id, project_id, attendance_date),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure attendance table exists: " + err.message);
  }
  try {
    // Optional free-text note a User can attach to their own Check In / Check
    // Out (e.g. "Site visit delayed — traffic", "Left early, cleared with PM").
    // Nullable/empty on both — remarks are never required.
    await dbPool.query(`ALTER TABLE attendance ADD COLUMN check_in_remarks TEXT NULL`);
    await dbPool.query(`ALTER TABLE attendance ADD COLUMN check_out_remarks TEXT NULL`);
  } catch (err: any) {
    console.warn("⚠️ Could not add attendance.check_in_remarks/check_out_remarks columns: " + err.message);
  }
  // Employee Tracking (Admin Panel -> Employee Tracking, ADMIN_MODULE_KEYS
  // "tracking") — every location ping the APK's background service sends while
  // it's running (see POST /api/tracking/ping), roughly every 5-10 minutes,
  // whether the app is in the foreground, minimized, or fully backgrounded. We
  // keep a full history (not just the latest point), so an Admin/Superadmin can
  // both see everyone's CURRENT position (latest row per user) and play back
  // WHERE a given user has been on a given day. Rows aren't pruned automatically
  // — see the recycle-bin-style cleanup pattern elsewhere if this needs capping.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS location_pings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        lat DECIMAL(10, 7) NOT NULL,
        lng DECIMAL(10, 7) NOT NULL,
        accuracy_m INT NULL,
        battery_pct INT NULL,
        recorded_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_location_pings_user_time (user_id, recorded_at)
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure location_pings table exists: " + err.message);
  }
  // Notices — Superadmin/Admin -> User popup shown right after the User logs in,
  // with optional custom Lottie animation (pasted JSON or a hosted URL) + free-form
  // text/HTML. See ADMIN_MODULE_KEYS ("notices") and the /api/notices* routes below.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS notices (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        content_html MEDIUMTEXT NOT NULL,
        lottie_json MEDIUMTEXT NULL,
        lottie_url VARCHAR(500) NULL,
        target_type ENUM('all','specific') NOT NULL DEFAULT 'all',
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS notice_targets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        notice_id INT NOT NULL,
        user_id INT NOT NULL,
        UNIQUE KEY unique_notice_user (notice_id, user_id),
        FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS notice_dismissals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        notice_id INT NOT NULL,
        user_id INT NOT NULL,
        dismissed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_notice_user_dismiss (notice_id, user_id),
        FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure notices/notice_targets/notice_dismissals tables exist: " + err.message);
  }
  // Employee Directory (Admin Panel -> Employees, ADMIN_MODULE_KEYS "employees").
  // Plain hand-entered reference data — employee_id/designation/department/
  // email/phone, none of it required except name — not linked to a login
  // account. Table name/columns mirror an existing `all_employees` export 1:1
  // so that data can be imported straight into this table if needed.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS all_employees (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id VARCHAR(50) NULL,
        name VARCHAR(255) NOT NULL,
        designation VARCHAR(255) NULL,
        department VARCHAR(255) NULL,
        email VARCHAR(255) NULL,
        phone VARCHAR(50) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        middle_name VARCHAR(255) NULL,
        gender VARCHAR(20) NULL,
        date_of_birth DATE NULL,
        nid_ssn VARCHAR(50) NULL,
        nationality VARCHAR(100) NULL,
        marital_status VARCHAR(30) NULL,
        blood_group VARCHAR(10) NULL,
        religion VARCHAR(50) NULL,
        is_foreigner TINYINT(1) NOT NULL DEFAULT 0,
        division VARCHAR(255) NULL,
        branch VARCHAR(255) NULL,
        unit VARCHAR(255) NULL,
        status_effective_date DATE NULL,
        job_status VARCHAR(50) NULL,
        job_status_effective_date DATE NULL,
        job_base VARCHAR(50) NULL,
        job_base_effective_date DATE NULL,
        review_month VARCHAR(20) NULL,
        employment_category VARCHAR(50) NULL,
        employment_category_effective_date DATE NULL,
        designation_effective_date DATE NULL,
        mobile VARCHAR(50) NULL,
        telephone VARCHAR(50) NULL,
        personal_email VARCHAR(255) NULL,
        present_address TEXT NULL,
        present_country VARCHAR(100) NULL,
        present_state VARCHAR(100) NULL,
        present_city VARCHAR(100) NULL,
        present_zip VARCHAR(20) NULL,
        permanent_address TEXT NULL,
        permanent_country VARCHAR(100) NULL,
        permanent_state VARCHAR(100) NULL,
        permanent_city VARCHAR(100) NULL,
        permanent_zip VARCHAR(20) NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure all_employees table exists: " + err.message);
  }
  // Supervisor assignments for an Employee Directory row (Admin Panel ->
  // Employees -> Edit -> Supervisor tab). The Supervisor is always another
  // row from the same all_employees list, picked from a dropdown — never
  // typed free-hand. See EMPLOYEE_EXT_FIELDS / /api/employees/:id/supervisors.
  // The row marked is_direct = 1 (an Employee may have several Supervisor
  // rows, but only ONE "Direct Supervisor") is what resolveSupervisorApprover
  // uses for the Approval Workflow auto-layer below — PROVIDED that Direct
  // Supervisor's own Employee Directory row is linked to a login account
  // (all_employees.user_id); a Supervisor with no login can't act on
  // approvals, so that case falls through to the Department Supervisor.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS employee_supervisors (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        supervisor_id INT NOT NULL,
        effective_date DATE NULL,
        is_direct TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
        FOREIGN KEY (supervisor_id) REFERENCES all_employees(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure employee_supervisors table exists: " + err.message);
  }
  // Departments (Admin Panel -> Departments, its own AdminModuleKey/module
  // permission) — real org-structure master data: every Employee Directory
  // row optionally belongs to exactly one Department (all_employees.
  // department_id below), and a Department optionally has a Supervisor — a
  // login account (users.id), NOT an all_employees.id like
  // employee_supervisors above, since the Supervisor needs to actually act
  // on Approval Workflow requests in the app. Unless
  // include_supervisor_approval is turned off, that Supervisor is
  // automatically inserted as this Department's first Approval Workflow
  // layer, ahead of whatever Approval Template applies (see
  // resolveDepartmentSupervisor / createTemplateApprovalRequest below) —
  // defaults ON, so simply setting a Supervisor is enough; no separate
  // Template step needs to be built for "my manager approves first".
  // Deliberately a SEPARATE concept from employee_supervisors (Admin Panel ->
  // Employees -> Edit -> Supervisor tab). Both now feed the same Approval
  // Workflow auto-layer (see resolveSupervisorApprover below): the Employee's
  // own "Direct Supervisor" (employee_supervisors) is tried FIRST, and only
  // when that Employee has none (or that Supervisor has no login account to
  // act with) does the Department Supervisor apply as the fallback.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS departments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(150) NOT NULL UNIQUE,
        supervisor_user_id INT NULL,
        include_supervisor_approval TINYINT(1) NOT NULL DEFAULT 1,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (supervisor_user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure departments table exists: " + err.message);
  }
  // "Movement Claims" — a free-form (not tied to a fixed Project geofence) point A
  // -> point B travel record: a User checks in with a Purpose (why/where they're
  // heading out for office work) then later checks out once they get there/finish.
  // Used for TA/DA-style reimbursement review in the Admin Panel -> Movement Claims
  // tab. Only one row per User may have status = 'open' at a time (enforced in
  // POST /api/claims/check-in) — distance_km is computed server-side on check-out.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS claims (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        purpose VARCHAR(255) NOT NULL,
        status ENUM('open','completed') NOT NULL DEFAULT 'open',
        check_in_at TIMESTAMP NULL DEFAULT NULL,
        check_in_lat DECIMAL(10, 7) NULL,
        check_in_lng DECIMAL(10, 7) NULL,
        check_in_remarks TEXT NULL,
        check_out_at TIMESTAMP NULL DEFAULT NULL,
        check_out_lat DECIMAL(10, 7) NULL,
        check_out_lng DECIMAL(10, 7) NULL,
        check_out_remarks TEXT NULL,
        distance_km DECIMAL(10, 2) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure claims table exists: " + err.message);
  }
  // "Conveyance Bill Claim" — Admin Panel tab restricted to the Superadmin and any
  // Admin the Superadmin explicitly grants the "conveyance" module to (see
  // ADMIN_MODULE_KEYS). One BILL groups several conveyance/travel line ITEMS for a
  // single User into one claim document. Each item is either pulled in from that
  // User's own completed "Movement Claim" (the `claims` table above — its
  // distance_km carries straight over so an Amount can be computed at a Rate/KM)
  // or entered fully by hand for a trip that was never logged as a Movement Claim
  // check-in/out at all (e.g. a one-off fare, or a trip from before this feature
  // existed). Item fields are copied from the source Claim at insert time rather
  // than just referencing it, so a bill's line items stay intact and printable
  // even if that Claim is later edited or removed elsewhere.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS conveyance_bills (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        bill_date DATE NOT NULL,
        remarks TEXT NULL,
        created_by INT NULL,
        -- Set once this Bill has actually been paid out (Admin Panel -> Conveyance
        -- Disbursement — its own "disbursement" AdminModuleKey, see
        -- ADMIN_MODULE_KEYS). Kept separate from the Bill/items above so an Admin
        -- can be trusted to BUILD bills without also being trusted to authorize
        -- payouts, and vice versa. voucher_no is reprinted on the Payment Voucher
        -- PDF every time; see POST /api/conveyance-bills/:id/disburse and .../undisburse.
        is_disbursed TINYINT(1) NOT NULL DEFAULT 0,
        voucher_no VARCHAR(100) NULL,
        disbursed_at TIMESTAMP NULL DEFAULT NULL,
        disbursed_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (disbursed_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS conveyance_bill_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        bill_id INT NOT NULL,
        source ENUM('movement_claim','manual') NOT NULL DEFAULT 'manual',
        -- Which Movement Claim this item came from, if any. UNIQUE so the same
        -- Claim can never end up billed twice across any Bill.
        claim_id INT NULL UNIQUE,
        entry_date DATE NOT NULL,
        particulars VARCHAR(255) NOT NULL,
        from_location VARCHAR(255) NULL,
        to_location VARCHAR(255) NULL,
        distance_km DECIMAL(10, 2) NULL,
        rate_per_km DECIMAL(10, 2) NULL,
        amount DECIMAL(12, 2) NOT NULL,
        remarks TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (bill_id) REFERENCES conveyance_bills(id) ON DELETE CASCADE,
        FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure conveyance_bills/conveyance_bill_items tables exist: " + err.message);
  }
  // Conveyance Disbursement columns — for a conveyance_bills table that already
  // existed before this feature (a fresh install gets these straight from the
  // CREATE TABLE above). Each ADD COLUMN/FOREIGN KEY is its own try/catch since
  // an already-existing column throws and would otherwise skip the rest.
  try {
    await dbPool.query(`ALTER TABLE conveyance_bills ADD COLUMN is_disbursed TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    // Column already exists — safe to ignore on every server restart after the first.
  }
  try {
    await dbPool.query(`ALTER TABLE conveyance_bills ADD COLUMN voucher_no VARCHAR(100) NULL`);
  } catch (err: any) {}
  try {
    await dbPool.query(`ALTER TABLE conveyance_bills ADD COLUMN disbursed_at TIMESTAMP NULL DEFAULT NULL`);
  } catch (err: any) {}
  try {
    await dbPool.query(`ALTER TABLE conveyance_bills ADD COLUMN disbursed_by INT NULL`);
  } catch (err: any) {}
  try {
    await dbPool.query(`ALTER TABLE conveyance_bills ADD FOREIGN KEY (disbursed_by) REFERENCES users(id) ON DELETE SET NULL`);
  } catch (err: any) {}
  // "Conveyance Bill Claim" (User Panel) — a User-submitted expense claim filled
  // in by hand (unlike the live GPS check-in/out `claims` table above), optionally
  // spanning several days (a multi-day tour) and optionally carrying a receipt/
  // attachment (same FileReader/Base64 -> LONGBLOB pattern as budgets.file_data —
  // no multipart/multer). Starts 'pending'; an Admin with the "conveyance" module
  // then Approves (which attaches it onto an official Conveyance Bill as a
  // conveyance_bill_items row, source = 'user_claim') or Rejects it with remarks.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS user_claims (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        claim_date DATE NOT NULL,
        from_date DATE NOT NULL,
        to_date DATE NOT NULL,
        category ENUM('Transport','Fuel','Toll','Parking','Others') NOT NULL DEFAULT 'Others',
        amount DECIMAL(12, 2) NOT NULL,
        description TEXT NULL,
        file_name VARCHAR(255) NULL,
        file_mimetype VARCHAR(150) NULL,
        file_data LONGBLOB NULL,
        status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
        admin_remarks TEXT NULL,
        reviewed_by INT NULL,
        reviewed_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    // Lets an Approved user_claim be attached onto a Conveyance Bill as its own
    // line item (source = 'user_claim'), alongside the existing 'movement_claim'/
    // 'manual' sources — UNIQUE so the same claim can never be billed twice.
    await dbPool.query(`
      ALTER TABLE conveyance_bill_items
        MODIFY COLUMN source ENUM('movement_claim','manual','user_claim') NOT NULL DEFAULT 'manual'
    `);
    const [ucCol]: any = await dbPool.query(`SHOW COLUMNS FROM conveyance_bill_items LIKE 'user_claim_id'`);
    if (!ucCol || ucCol.length === 0) {
      await dbPool.query(`
        ALTER TABLE conveyance_bill_items
          ADD COLUMN user_claim_id INT NULL UNIQUE AFTER claim_id,
          ADD FOREIGN KEY (user_claim_id) REFERENCES user_claims(id) ON DELETE SET NULL
      `);
    }
  } catch (err: any) {
    console.warn("⚠️ Could not ensure user_claims table / conveyance_bill_items.user_claim_id exists: " + err.message);
  }
  // Approved Amount — set by the approver at Approvals-tab decision time (Admin
  // Panel -> Approvals). Lets the approver partially approve a Conveyance Bill
  // Claim (approve for less than what was claimed); Remaining Amount (Claim
  // Amount - Approved Amount) is derived live from these two, never stored.
  // NULL until a decision is made (still 'pending') and for anything decided
  // before this feature existed.
  try {
    await dbPool.query(`ALTER TABLE user_claims ADD COLUMN approved_amount DECIMAL(12, 2) NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add user_claims.approved_amount column: " + err.message);
    }
  }
  // Lets a Conveyance Bill Claim reference one or more of the User's own completed
  // Movement Claims (check-in/out), each with its own Amount — see the long
  // comment on this table in schema.sql. UNIQUE claim_id means a given check-in/
  // out can only ever be referenced by ONE Conveyance Bill Claim.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS user_claim_references (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_claim_id INT NOT NULL,
        claim_id INT NOT NULL UNIQUE,
        amount DECIMAL(12, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_claim_id) REFERENCES user_claims(id) ON DELETE CASCADE,
        FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure user_claim_references table exists: " + err.message);
  }
  // Approval Workflow — a single global, ORDERED chain of Admin/Superadmin
  // approvers (Admin Panel -> Approvals, Superadmin-only to edit). See the long
  // comment above these tables in schema.sql for the full flow.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS approval_chain_steps (
        id INT AUTO_INCREMENT PRIMARY KEY,
        step_order INT NOT NULL,
        user_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_step_order (step_order),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS approval_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        source_type ENUM('attendance','claim','user_claim','attendance_correction') NOT NULL,
        event_type ENUM('check_in','check_out','submit') NOT NULL,
        source_id INT NOT NULL,
        requested_by INT NOT NULL,
        status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
        current_step INT NOT NULL DEFAULT 1,
        total_steps INT NOT NULL,
        actions_json MEDIUMTEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    // Widen the ENUMs for existing databases created before Conveyance Bill Claims /
    // Attendance Correction requests routed through this same Approval Workflow engine.
    await dbPool.query(`
      ALTER TABLE approval_requests
        MODIFY COLUMN source_type ENUM('attendance','claim','user_claim','attendance_correction','leave_application') NOT NULL,
        MODIFY COLUMN event_type ENUM('check_in','check_out','submit') NOT NULL
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure approval_chain_steps/approval_requests tables exist: " + err.message);
  }
  // ============================================================================
  // Approval Workflow TEMPLATES (Dynamic Approval Engine — Part 1 of 5).
  // Superadmin can pre-build any number of named templates, each an ORDERED list
  // of Layers/Steps, one per request_type (Conveyance Bill Claim / Leave
  // Application / Timesheet=Attendance Correction). See the long design comment
  // above approval_chain_steps for the OLD single-global-chain engine this is
  // replacing — that table/engine is left untouched here; Part 5 migrates it
  // into this new system without breaking any in-flight request.
  // ============================================================================
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS approval_templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        request_type ENUM('conveyance','leave','timesheet') NOT NULL,
        -- Company-wide fallback for this request_type — used whenever a
        -- submitting Employee has no row in employee_template_assignments
        -- for this request_type. "At most one default per request_type" is
        -- enforced in the API layer (Part 2), not a DB constraint — MySQL
        -- can't express a conditional-unique index this cleanly without a
        -- generated column.
        is_default TINYINT(1) NOT NULL DEFAULT 0,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    // One row per Layer/Step inside a template, in step_order (1, 2, 3...).
    // Deliberately holds NO approver column itself — a step's approver(s) live
    // in approval_template_step_approvers below, since a step can hold more
    // than one Employee (see that table's comment).
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS approval_template_steps (
        id INT AUTO_INCREMENT PRIMARY KEY,
        template_id INT NOT NULL,
        step_order INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_template_step_order (template_id, step_order),
        FOREIGN KEY (template_id) REFERENCES approval_templates(id) ON DELETE CASCADE
      )
    `);
    // One or more Approvers per Step. ANY ONE of a step's approvers Approving
    // is enough to clear that step and move the request to the next one —
    // this is how "put a whole Department on Layer 2" is modeled: every
    // member of that Department gets their own row here against the same
    // step_id. A single named individual on a step is just the n=1 case of
    // this same table.
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS approval_template_step_approvers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        step_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_step_user (step_id, user_id),
        FOREIGN KEY (step_id) REFERENCES approval_template_steps(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    // Per-Employee, per-Request-Type template pick (Admin Panel -> new
    // "Template Assignment" screen, Part 2). At most one row per
    // (employee_user_id, request_type) — the active row is REPLACED, never
    // duplicated, whenever an Admin re-assigns that Employee's template for
    // that request type. Missing row = no explicit assignment -> falls back
    // to approval_templates.is_default for that request_type (Part 3) -> if
    // there's no default either, the request auto-approves (Part 3 edge case).
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS employee_template_assignments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_user_id INT NOT NULL,
        request_type ENUM('conveyance','leave','timesheet') NOT NULL,
        template_id INT NOT NULL,
        assigned_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_employee_request_type (employee_user_id, request_type),
        FOREIGN KEY (employee_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (template_id) REFERENCES approval_templates(id) ON DELETE CASCADE,
        FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure approval_templates/approval_template_steps/approval_template_step_approvers/employee_template_assignments tables exist: " + err.message);
  }
  // Dynamic Approval Engine (Part 3) — which Template (if any) is driving a
  // given approval_requests row. NULL means it's riding the OLD global chain
  // (approval_chain_steps, via getApprovalChain()) exactly as before; a value
  // here means current_step is a step_order into THIS template's own steps
  // instead (see getCurrentStepApprovers). Placed here (after
  // approval_templates exists) since it's an FK onto that table. Self-healing
  // ADD COLUMN, same ER_DUP_FIELDNAME-ignoring pattern as every other column
  // addition in this file.
  try {
    await dbPool.query(`ALTER TABLE approval_requests ADD COLUMN template_id INT NULL`);
    await dbPool.query(`ALTER TABLE approval_requests ADD FOREIGN KEY (template_id) REFERENCES approval_templates(id) ON DELETE SET NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME" && err.code !== "ER_DUP_KEYNAME" && err.code !== "ER_FK_DUP_NAME") {
      console.warn("⚠️ Could not add approval_requests.template_id column: " + err.message);
    }
  }
  // Supervisor auto-layer (see resolveSupervisorApprover /
  // createTemplateApprovalRequest) — when set,
  // this request's step_order 1 is the Supervisor (Employee's own Direct
  // Supervisor, or the Department Supervisor as fallback) rather than the
  // Template's own step 1 (the Template's steps shift down to step_order 2, 3,
  // ... — see getCurrentStepApprovers), and total_steps already includes this
  // extra layer. NULL means this request has no Supervisor gate (no usable
  // Direct Supervisor or Department Supervisor found, or the Supervisor would
  // have been approving their own request) — current_step 1 is then the
  // Template's own step 1, exactly as before this feature existed.
  try {
    await dbPool.query(`ALTER TABLE approval_requests ADD COLUMN supervisor_step_user_id INT NULL`);
    await dbPool.query(`ALTER TABLE approval_requests ADD FOREIGN KEY (supervisor_step_user_id) REFERENCES users(id) ON DELETE SET NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME" && err.code !== "ER_DUP_KEYNAME" && err.code !== "ER_FK_DUP_NAME") {
      console.warn("⚠️ Could not add approval_requests.supervisor_step_user_id column: " + err.message);
    }
  }
  // Timesheet -> click any date's row to manually fix that day's In/Out Time
  // (typically a day with no attendance at all, but any day can be corrected).
  // Submitting one NEVER touches the `attendance` table directly — it only
  // records the REQUEST here, 'pending' until an Admin reviews it. Routed
  // through the exact same global Approval Workflow chain as Attendance Check
  // In/Out and Conveyance Bill Claims (see createApprovalRequest/
  // POST /api/approvals/:id/act) — no separate review page needed, it already
  // shows up in the existing Admin Panel -> Approvals queue. Only on the LAST
  // step's Approve does finalizeAttendanceCorrection actually write the
  // requested times into `attendance` (creating that day's row if it didn't
  // exist yet); a Reject leaves `attendance` untouched. Optional remarks (why
  // the edit is needed) and an optional Image/PDF attachment, same
  // FileReader/Base64 -> LONGBLOB pattern as user_claims.file_data.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS attendance_corrections (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        project_id INT NOT NULL,
        attendance_date DATE NOT NULL,
        requested_check_in_at DATETIME NULL,
        requested_check_out_at DATETIME NULL,
        remarks TEXT NULL,
        file_name VARCHAR(255) NULL,
        file_mimetype VARCHAR(150) NULL,
        file_data LONGBLOB NULL,
        status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
        admin_remarks TEXT NULL,
        reviewed_by INT NULL,
        reviewed_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure attendance_corrections table exists: " + err.message);
  }
  // Self Service -> Leave Management — one row per Admin/User account holding how
  // many days of each leave type they currently have left. A missing row just
  // means 0 for all three (see GET/PUT /api/leave-balances below); it's only
  // created on first save, not when the account itself is created.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS leave_balances (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        casual_leave DECIMAL(5, 1) NOT NULL DEFAULT 0,
        sick_leave DECIMAL(5, 1) NOT NULL DEFAULT 0,
        leave_without_pay DECIMAL(5, 1) NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user_leave (user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure leave_balances table exists: " + err.message);
  }
  // Self Service -> Leave Application — one row per submitted application.
  // Submitting one immediately deducts day_count from the matching
  // leave_balances column (see POST /api/leave-applications below).
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS leave_applications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        leave_type ENUM('casual', 'sick', 'without_pay') NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        day_count DECIMAL(5, 1) NOT NULL,
        is_continuous TINYINT(1) NOT NULL DEFAULT 0,
        is_prefix TINYINT(1) NOT NULL DEFAULT 0,
        is_suffix TINYINT(1) NOT NULL DEFAULT 0,
        is_half_day TINYINT(1) NOT NULL DEFAULT 0,
        include_extra_work_dates TINYINT(1) NOT NULL DEFAULT 0,
        is_foreign_leave TINYINT(1) NOT NULL DEFAULT 0,
        purpose TEXT NOT NULL,
        approver_id INT NOT NULL,
        status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
        apply_date DATE NOT NULL,
        remarks TEXT NULL,
        decided_by INT NULL,
        decided_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (approver_id) REFERENCES users(id)
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure leave_applications table exists: " + err.message);
  }
  // Widen an already-created leave_applications table (from before Approve/Reject
  // existed) with the decision columns — safe no-op if they're already there.
  try {
    await dbPool.query(`ALTER TABLE leave_applications ADD COLUMN remarks TEXT NULL`);
  } catch (err: any) {
    // Already exists on a fresh install — ignore silently.
  }
  try {
    await dbPool.query(`ALTER TABLE leave_applications ADD COLUMN decided_by INT NULL`);
  } catch (err: any) {
    // Already exists on a fresh install — ignore silently.
  }
  try {
    await dbPool.query(`ALTER TABLE leave_applications ADD COLUMN decided_at TIMESTAMP NULL`);
  } catch (err: any) {
    // Already exists on a fresh install — ignore silently.
  }
  // Dynamic Approval Engine (Part 5) — Leave Application no longer has the
  // applicant pick their own Approver at submission; it's now routed through
  // this Employee's assigned Template for request_type 'leave' instead (same
  // as Conveyance/Timesheet, Part 3), tracked via its own approval_requests
  // row (source_type 'leave_application'). approver_id is widened to NULL-able
  // here purely so NEW applications can leave it unset — existing PENDING
  // applications keep whatever approver_id they already had and are decided
  // exactly as before via POST /api/leave-applications/:id/decision (see that
  // route and resolveApprovalTemplate's design note for the full migration
  // story). This MODIFY COLUMN is naturally idempotent — safe to run on every
  // startup, unlike an ADD COLUMN.
  try {
    await dbPool.query(`ALTER TABLE leave_applications MODIFY COLUMN approver_id INT NULL`);
  } catch (err: any) {
    console.warn("⚠️ Could not widen leave_applications.approver_id to NULL-able: " + err.message);
  }

  // Reliever workflow — the applicant now picks a Reliever (ANY account, not
  // just Admin/Superadmin) when applying; the request sits waiting on that
  // Reliever's own Approve/Reject FIRST (reliever_status/reliever_* below),
  // completely separate from — and before — the Dynamic Approval Engine
  // (Part 5) routing above. Only once the Reliever Approves does
  // createTemplateApprovalRequest ever get called for this application (see
  // POST /api/leave-applications and POST
  // /api/leave-applications/:id/reliever-decision). Reliever Rejecting ends
  // the application immediately, exactly like a normal Template-step Reject
  // (refunds the day_count) — it never reaches the Approval Engine at all.
  // All ADD COLUMNs, safe no-ops on a DB that already has them.
  try {
    await dbPool.query(`ALTER TABLE leave_applications ADD COLUMN reliever_id INT NULL`);
  } catch (err: any) {
    // Already exists on a fresh install — ignore silently.
  }
  try {
    await dbPool.query(`ALTER TABLE leave_applications ADD COLUMN reliever_status ENUM('pending','approved','rejected') NULL DEFAULT NULL`);
  } catch (err: any) {
    // Already exists on a fresh install — ignore silently.
  }
  try {
    await dbPool.query(`ALTER TABLE leave_applications ADD COLUMN reliever_remarks TEXT NULL`);
  } catch (err: any) {
    // Already exists on a fresh install — ignore silently.
  }
  try {
    await dbPool.query(`ALTER TABLE leave_applications ADD COLUMN reliever_decided_by INT NULL`);
  } catch (err: any) {
    // Already exists on a fresh install — ignore silently.
  }
  try {
    await dbPool.query(`ALTER TABLE leave_applications ADD COLUMN reliever_decided_at TIMESTAMP NULL`);
  } catch (err: any) {
    // Already exists on a fresh install — ignore silently.
  }

  // Links an Employee Directory row (all_employees) to the login account (a
  // users row) created for it at the same time — see POST /api/employees'
  // create_login option. NULL for the (still-normal) case of a directory
  // entry with no account. Self-healing for any database created before this
  // feature existed, same ER_DUP_FIELDNAME-ignoring pattern as every other
  // column addition above.
  try {
    await dbPool.query(`ALTER TABLE all_employees ADD COLUMN user_id INT NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add all_employees.user_id column: " + err.message);
    }
  }

  // Links an Employee Directory row to its structured Department (Admin Panel
  // -> Departments, above) — self-healing for any database created before
  // this feature existed, same pattern as user_id above. Placed after
  // `departments` exists, since this is an FK onto that table.
  try {
    await dbPool.query(`ALTER TABLE all_employees ADD COLUMN department_id INT NULL`);
    await dbPool.query(`ALTER TABLE all_employees ADD FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME" && err.code !== "ER_DUP_KEYNAME" && err.code !== "ER_FK_DUP_NAME") {
      console.warn("⚠️ Could not add all_employees.department_id column: " + err.message);
    }
  }

  // One-time-per-value migration: seed `departments` from any distinct
  // legacy free-text all_employees.department values that don't have a
  // matching Department row yet, then backfill department_id for every
  // directory row still missing it. Safe to run on every startup —
  // INSERT...SELECT...WHERE NOT EXISTS only inserts names not already there,
  // and the UPDATE only touches rows still NULL, so a department_id an Admin
  // already reassigned (or deliberately cleared) is never touched again.
  try {
    await dbPool.query(`
      INSERT INTO departments (name)
      SELECT DISTINCT TRIM(e.department) FROM all_employees e
      WHERE e.department IS NOT NULL AND TRIM(e.department) <> ''
        AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.name = TRIM(e.department))
    `);
    await dbPool.query(`
      UPDATE all_employees e
      JOIN departments d ON d.name = TRIM(e.department)
      SET e.department_id = d.id
      WHERE e.department_id IS NULL AND e.department IS NOT NULL AND TRIM(e.department) <> ''
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not migrate free-text all_employees.department values into the departments table: " + err.message);
  }

  // Employee Info / Status / Contact tab columns (Admin Panel -> Employees ->
  // Edit) added after the original all_employees table — self-healing for any
  // database created before these existed, same ER_DUP_FIELDNAME-ignoring
  // pattern as user_id above. EMPLOYEE_EXT_FIELDS is the single source of
  // truth for these column names/types, shared with the GET/POST/PUT
  // /api/employees handlers further down.
  for (const { name, ddl } of EMPLOYEE_EXT_FIELD_DDL) {
    try {
      await dbPool.query(`ALTER TABLE all_employees ADD COLUMN ${name} ${ddl}`);
    } catch (err: any) {
      if (err.code !== "ER_DUP_FIELDNAME") {
        console.warn(`⚠️ Could not add all_employees.${name} column: ` + err.message);
      }
    }
  }

  // ============================================================================
  // Dynamic Approval Engine (Part 5) — one-time migration of the OLD global
  // Approval Chain into the NEW Template system, so a company that already had
  // a working chain configured doesn't suddenly have every Conveyance/Leave/
  // Timesheet request auto-approve the moment this feature ships (Part 3/5's
  // "no Template configured -> auto-approve" edge case is only meant to fire
  // for a genuinely unconfigured company). For EACH request_type that has NO
  // Templates at all yet, this clones the old chain's steps/approvers 1:1 into
  // a brand-new, already-active, already-default Template — so behavior is
  // unchanged by default, and the Superadmin can later build a real,
  // distinct-per-type Template whenever they're ready to.
  //
  // Deliberately per-request_type and gated on "zero Templates exist yet",
  // not just "no default exists yet" — so it never overwrites or duplicates
  // anything once an Admin has started customizing that request_type, and it
  // safely no-ops on every subsequent restart once the one-time clone is done.
  // If the old chain has zero steps (nothing was ever configured), nothing is
  // created — a fresh install auto-approving until someone builds a Template
  // is the correct, intended behavior in that case.
  // ============================================================================
  try {
    const chain = await getApprovalChain();
    if (chain.length > 0) {
      const requestTypes: { key: "conveyance" | "leave" | "timesheet"; label: string }[] = [
        { key: "conveyance", label: "Conveyance Bill Claim" },
        { key: "leave", label: "Leave Application" },
        { key: "timesheet", label: "Timesheet" }
      ];
      for (const rt of requestTypes) {
        const existingTemplates = await queryDB("SELECT COUNT(*) AS cnt FROM approval_templates WHERE request_type = ?", [rt.key]);
        if (Number(existingTemplates[0]?.cnt || 0) > 0) continue;
        const templateResult = await queryDB(
          "INSERT INTO approval_templates (name, request_type, is_default, is_active, created_by) VALUES (?, ?, 1, 1, NULL)",
          [`Migrated Global Chain \u2014 ${rt.label}`, rt.key]
        );
        const templateId = templateResult.insertId;
        for (const step of chain) {
          const stepResult = await queryDB("INSERT INTO approval_template_steps (template_id, step_order) VALUES (?, ?)", [templateId, step.step_order]);
          await queryDB("INSERT INTO approval_template_step_approvers (step_id, user_id) VALUES (?, ?)", [stepResult.insertId, step.user_id]);
        }
        console.log(`\u2705 Migrated the old global Approval Chain into a default Template for '${rt.key}' (Admin Panel -> Approvals -> Templates).`);
      }
    }
  } catch (err: any) {
    console.warn("⚠️ Could not migrate the old global Approval Chain into default Templates: " + err.message);
  }
}

// Every Admin Panel tab, gated per-Admin by the Superadmin. Kept as a single source
// of truth here and mirrored in src/types.ts (ADMIN_MODULES) for the UI.
const USER_CLAIM_CATEGORIES = ["Transport", "Fuel", "Toll", "Parking", "Others"] as const;

const ADMIN_MODULE_KEYS = ["projects", "branches", "mprs", "imports", "reports", "users", "attendance", "attendance_reports", "recycle", "editlog", "notices", "claims", "approvals", "conveyance", "disbursement", "employees", "departments", "tracking", "office_attendance", "holidays", "payroll"] as const;

// Employee Directory extended profile fields (Admin Panel -> Employees ->
// Edit -> Employee Info / Status / Contact tabs). Single source of truth for
// column names — used to build the ALTER TABLE migration above and the
// dynamic INSERT/UPDATE in POST/PUT /api/employees below, so the three never
// drift out of sync. DATE fields are stored/sent as 'YYYY-MM-DD' strings (or
// null); everything else is a plain string column (or null) except
// is_foreigner, which is 0/1.
const EMPLOYEE_TEXT_FIELDS = [
  "middle_name", "gender", "nid_ssn", "nationality", "marital_status", "blood_group", "religion",
  "division", "branch", "unit", "job_status", "job_base", "review_month", "employment_category",
  "mobile", "telephone", "personal_email",
  "present_address", "present_country", "present_state", "present_city", "present_zip",
  "permanent_address", "permanent_country", "permanent_state", "permanent_city", "permanent_zip"
] as const;
const EMPLOYEE_DATE_FIELDS = [
  "date_of_birth", "status_effective_date", "job_status_effective_date", "job_base_effective_date",
  "employment_category_effective_date", "designation_effective_date"
] as const;
const EMPLOYEE_BOOL_FIELDS = ["is_foreigner"] as const;
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
    const rows: any = await queryDB("SELECT module_key FROM admin_module_permissions WHERE user_id = ?", [userId]);
    return rows.map((r: any) => r.module_key);
  } catch {
    return [];
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
async function resolveApprovalTemplate(employeeUserId: number, requestType: "conveyance" | "leave" | "timesheet"): Promise<any | null> {
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
    const def = await queryDB("SELECT * FROM approval_templates WHERE request_type = ? AND is_default = 1 AND is_active = 1 LIMIT 1", [requestType]);
    if (def.length > 0) return def[0];
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
  requestType: "conveyance" | "leave" | "timesheet",
  sourceType: "user_claim" | "attendance_correction" | "leave_application",
  sourceId: number,
  requestedBy: number
): Promise<{ autoApproved: boolean; template: any | null }> {
  const supervisorId = await resolveSupervisorApprover(requestedBy);

  let template = await resolveApprovalTemplate(requestedBy, requestType);
  let templateSteps = 0;
  if (template) {
    const stepCountRows = await queryDB("SELECT COUNT(*) AS cnt FROM approval_template_steps WHERE template_id = ?", [template.id]);
    templateSteps = Number(stepCountRows[0]?.cnt || 0);
    // A Template somehow has zero steps (Part 2's editor always requires at
    // least one, but defend against a row created some other way) — treat
    // this exactly like "no template at all" (the Supervisor gate above, if
    // any, still applies on its own).
    if (templateSteps === 0) template = null;
  }

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
  action: "approved" | "rejected",
  remarks: string | null,
  billId: number | null,
  approvedAmount?: number | null
): Promise<{ status: string; current_step: number; billInfo: { bill_id: number; bill_item_id: number } | null }> {
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
  let billInfo: { bill_id: number; bill_item_id: number } | null = null;
  if (request.source_type === "user_claim") {
    try {
      if (newStatus === "approved") {
        billInfo = await finalizeUserClaimApproval(Number(request.source_id), actorUser.id, billId, remarks, approvedAmount);
      } else if (newStatus === "rejected") {
        await rejectUserClaimRecord(Number(request.source_id), actorUser.id, remarks);
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
    if (amt > Number(uc.amount)) {
      throw new Error("Approved Amount can't be more than the Claim Amount.");
    }
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

  return { bill_id: targetBillId, bill_item_id: item.insertId };
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
  if (amt > Number(uc.amount)) {
    throw new Error("Approved Amount can't be more than the Claim Amount.");
  }

  await queryDB("UPDATE user_claims SET approved_amount = ? WHERE id = ?", [amt, userClaimId]);
}

// Rejects a User Claim — frees up any referenced check-in/out(s) (a rejected claim
// never becomes a Bill line item, so there's no reason to keep them unavailable)
// and marks the claim 'rejected'. Shared by the same two callers as
// finalizeUserClaimApproval above.
async function rejectUserClaimRecord(userClaimId: number, rejectedBy: number, remarks: string | null) {
  await queryDB("DELETE FROM user_claim_references WHERE user_claim_id = ?", [userClaimId]);
  await queryDB(
    "UPDATE user_claims SET status = 'rejected', admin_remarks = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
    [remarks, rejectedBy, userClaimId]
  );
}

// Approves a Leave Application (Part 5 of 5) — day_count was ALREADY deducted
// from leave_balances at submission time (see POST /api/leave-applications),
// so approving here only flips status + notifies the applicant; nothing else
// to move. Shared by the no-Template auto-approve edge case and
// performApprovalAction's LAST-step approval — same pattern as
// finalizeAttendanceCorrection/finalizeUserClaimApproval above.
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

  const leaveTypeLabel = application.leave_type === "casual" ? "Casual" : application.leave_type === "sick" ? "Sick" : "Leave Without Pay";
  await createAlert(queryDB, {
    userId: application.user_id,
    type: "leave_application",
    title: "Leave Application Approved",
    message: `Your ${leaveTypeLabel} Leave (${toDateOnlyString(application.start_date)} to ${toDateOnlyString(application.end_date)}) has been approved.`,
    relatedType: "leave_application",
    relatedId: application.id
  });
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

  const balanceColumn = application.leave_type === "casual" ? "casual_leave" : application.leave_type === "sick" ? "sick_leave" : "leave_without_pay";
  const balanceRows = await queryDB("SELECT * FROM leave_balances WHERE user_id = ?", [application.user_id]);
  const casual = Number(balanceRows[0]?.casual_leave || 0) + (balanceColumn === "casual_leave" ? Number(application.day_count) : 0);
  const sick = Number(balanceRows[0]?.sick_leave || 0) + (balanceColumn === "sick_leave" ? Number(application.day_count) : 0);
  const lwp = Number(balanceRows[0]?.leave_without_pay || 0) + (balanceColumn === "leave_without_pay" ? Number(application.day_count) : 0);
  if (balanceRows.length > 0) {
    await queryDB("UPDATE leave_balances SET casual_leave = ?, sick_leave = ?, leave_without_pay = ? WHERE user_id = ?", [
      casual,
      sick,
      lwp,
      application.user_id
    ]);
  } else {
    await queryDB("INSERT INTO leave_balances (user_id, casual_leave, sick_leave, leave_without_pay) VALUES (?, ?, ?, ?)", [
      application.user_id,
      casual,
      sick,
      lwp
    ]);
  }

  await queryDB("UPDATE leave_applications SET status = 'rejected', remarks = ?, decided_by = ?, decided_at = NOW() WHERE id = ?", [
    remarks,
    rejectedBy,
    leaveId
  ]);

  const leaveTypeLabel = application.leave_type === "casual" ? "Casual" : application.leave_type === "sick" ? "Sick" : "Leave Without Pay";
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
    const leaveTypeLabel = application.leave_type === "casual" ? "Casual" : application.leave_type === "sick" ? "Sick" : "Leave Without Pay";
    await createAlert(queryDB, {
      userId: application.user_id,
      type: "leave_application",
      title: "Reliever Approved Your Leave Application",
      message: `Your Reliever approved your ${leaveTypeLabel} Leave (${toDateOnlyString(application.start_date)} to ${toDateOnlyString(application.end_date)}). It's now with the Approval Workflow.`,
      relatedType: "leave_application",
      relatedId: application.id
    });
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
  const colList = columns.join(", ");
  const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => rowPlaceholder).join(", ");
    await dbPool.execute(`INSERT INTO ${table} (${colList}) VALUES ${placeholders}`, chunk.flat());
  }
}

async function queryDB(sql: string, params: any[] = []): Promise<any> {
  if (isMySQLConnected && dbPool) {
    try {
      const [rows] = await dbPool.execute(sql, params);
      return rows;
    } catch (err) {
      console.error("MySQL query error:", err);
      throw err;
    }
  } else {
    // Memory DB simulation for SQL statements
    const lowerSql = sql.trim().toLowerCase();
    
    // USERS
    if (lowerSql.startsWith("select * from users where email = ? or username")) {
      const [email, username] = params;
      return memoryDb.users.filter(u => u.email === email || (u.username && u.username === username));
    }
    if (lowerSql.startsWith("select * from users where email")) {
      const email = params[0];
      return memoryDb.users.filter(u => u.email === email);
    }
    if (lowerSql.startsWith("select * from users where id")) {
      const id = params[0];
      return memoryDb.users.filter(u => u.id === id);
    }
    if (lowerSql.startsWith("select id from users where id")) {
      const id = Number(params[0]);
      return memoryDb.users.filter(u => u.id === id).map(u => ({ id: u.id }));
    }
    if (lowerSql.startsWith("select username, password_hash from users")) {
      return memoryDb.users.map(u => ({ username: u.username || null, password_hash: u.password_hash }));
    }
    if (lowerSql.startsWith("select id, name, email, username, role, created_at, last_login_lat")) {
      return memoryDb.users.map(({ password_hash, ...u }) => ({
        ...u,
        username: u.username || null,
        last_login_lat: u.last_login_lat ?? null,
        last_login_lng: u.last_login_lng ?? null,
        last_login_at: u.last_login_at ?? null,
        can_edit_delivery_date: u.can_edit_delivery_date !== false,
        can_job_edit: !!u.can_job_edit,
        can_use_attendance: !!u.can_use_attendance,
        can_use_tracking: !!u.can_use_tracking,
        can_view_login_location: !!u.can_view_login_location,
        can_access_user_panel: !!u.can_access_user_panel,
        can_manage_leave: !!u.can_manage_leave,
        can_view_movement_claims: !!u.can_view_movement_claims,
        can_view_conveyance_claims: !!u.can_view_conveyance_claims,
        can_view_budget_module: u.can_view_budget_module !== false,
        can_view_leave_summary: !!u.can_view_leave_summary
      }));
    }
    if (lowerSql.startsWith("select id, name, email, role, created_at, can_edit_delivery_date, can_job_edit, can_use_attendance, can_view_login_location, can_access_user_panel, can_manage_leave, can_view_movement_claims, can_view_conveyance_claims from users")) {
      const id = Number(params[0]);
      const user = memoryDb.users.find(u => u.id === id);
      if (!user) return [];
      const { password_hash, ...rest } = user;
      return [{
        ...rest,
        can_edit_delivery_date: rest.can_edit_delivery_date !== false ? 1 : 0,
        can_job_edit: rest.can_job_edit ? 1 : 0,
        can_use_attendance: rest.can_use_attendance ? 1 : 0,
        can_use_tracking: rest.can_use_tracking ? 1 : 0,
        can_view_login_location: rest.can_view_login_location ? 1 : 0,
        can_access_user_panel: rest.can_access_user_panel ? 1 : 0,
        can_manage_leave: rest.can_manage_leave ? 1 : 0,
        can_view_movement_claims: rest.can_view_movement_claims ? 1 : 0,
        can_view_conveyance_claims: rest.can_view_conveyance_claims ? 1 : 0,
        can_view_budget_module: rest.can_view_budget_module !== false ? 1 : 0,
        can_view_leave_summary: rest.can_view_leave_summary ? 1 : 0
      }];
    }
    if (lowerSql.startsWith("select can_view_budget_module from users where id")) {
      const id = Number(params[0]);
      const user = memoryDb.users.find(u => u.id === id);
      if (!user) return [];
      return [{ can_view_budget_module: user.can_view_budget_module !== false ? 1 : 0 }];
    }
    if (lowerSql.startsWith("select can_manage_leave from users where id")) {
      const id = Number(params[0]);
      const user = memoryDb.users.find(u => u.id === id);
      if (!user) return [];
      return [{ can_manage_leave: user.can_manage_leave ? 1 : 0 }];
    }
    if (lowerSql.startsWith("select can_view_movement_claims from users where id")) {
      const id = Number(params[0]);
      const user = memoryDb.users.find(u => u.id === id);
      if (!user) return [];
      return [{ can_view_movement_claims: user.can_view_movement_claims ? 1 : 0 }];
    }
    if (lowerSql.startsWith("select can_view_conveyance_claims from users where id")) {
      const id = Number(params[0]);
      const user = memoryDb.users.find(u => u.id === id);
      if (!user) return [];
      return [{ can_view_conveyance_claims: user.can_view_conveyance_claims ? 1 : 0 }];
    }
    if (lowerSql.startsWith("select can_use_attendance from users where id")) {
      const id = Number(params[0]);
      const user = memoryDb.users.find(u => u.id === id);
      if (!user) return [];
      return [{ can_use_attendance: user.can_use_attendance ? 1 : 0 }];
    }
    if (lowerSql.startsWith("select id, name, email, role, created_at from users")) {
      return memoryDb.users.map(({ password_hash, ...u }) => u);
    }
    if (lowerSql.startsWith("insert into users (name, email, username, password_hash, role)")) {
      const [name, username, password_hash] = params;
      const newId = memoryDb.users.length + 1;
      const newUser = { id: newId, name, email: null, username, password_hash, role: 'user', created_at: new Date(), can_edit_delivery_date: true, can_job_edit: false, can_view_login_location: false, can_access_user_panel: false, can_view_budget_module: true };
      memoryDb.users.push(newUser);
      return { insertId: newId };
    }
    if (lowerSql.startsWith("insert into users")) {
      const [name, email, password_hash, role] = params;
      const newId = memoryDb.users.length + 1;
      const newUser = { id: newId, name, email, username: null, password_hash, role: role || 'user', created_at: new Date(), can_edit_delivery_date: true, can_job_edit: false, can_view_login_location: false, can_access_user_panel: false, can_view_budget_module: true };
      memoryDb.users.push(newUser);
      return { insertId: newId };
    }
    if (lowerSql.startsWith("update users set role")) {
      const [role, id] = params;
      const user = memoryDb.users.find(u => u.id === id);
      if (user) user.role = role;
      return { affectedRows: user ? 1 : 0 };
    }
    if (lowerSql.startsWith("update users set password_hash")) {
      const [password_hash, id] = params;
      const user: any = memoryDb.users.find(u => u.id === Number(id));
      if (user) user.password_hash = password_hash;
      return { affectedRows: user ? 1 : 0 };
    }
    if (lowerSql.startsWith("update users set last_login_lat")) {
      const [lat, lng, id] = params;
      const user = memoryDb.users.find(u => u.id === id);
      if (user) {
        user.last_login_lat = lat;
        user.last_login_lng = lng;
        user.last_login_at = new Date();
      }
      return { affectedRows: user ? 1 : 0 };
    }
    if (lowerSql.startsWith("select can_edit_delivery_date, can_job_edit from users")) {
      const id = Number(params[0]);
      const user = memoryDb.users.find(u => u.id === id);
      return user
        ? [{ can_edit_delivery_date: user.can_edit_delivery_date !== false ? 1 : 0, can_job_edit: user.can_job_edit ? 1 : 0 }]
        : [];
    }
    if (lowerSql.startsWith("select can_job_edit from users")) {
      const id = Number(params[0]);
      const user = memoryDb.users.find(u => u.id === id);
      return user ? [{ can_job_edit: user.can_job_edit ? 1 : 0 }] : [];
    }
    if (lowerSql.startsWith("update users set can_edit_delivery_date")) {
      const [can_edit_delivery_date, can_job_edit, can_use_attendance, id] = params;
      const user = memoryDb.users.find(u => u.id === Number(id));
      if (user) {
        user.can_edit_delivery_date = !!Number(can_edit_delivery_date);
        user.can_job_edit = !!Number(can_job_edit);
        user.can_use_attendance = !!Number(can_use_attendance);
      }
      return { affectedRows: user ? 1 : 0 };
    }
    if (lowerSql.startsWith("update users set can_view_login_location")) {
      const [can_view_login_location, id] = params;
      const user = memoryDb.users.find(u => u.id === Number(id));
      if (user) user.can_view_login_location = !!Number(can_view_login_location);
      return { affectedRows: user ? 1 : 0 };
    }
    if (lowerSql.startsWith("update users set can_access_user_panel")) {
      const [can_access_user_panel, id] = params;
      const user = memoryDb.users.find(u => u.id === Number(id));
      if (user) user.can_access_user_panel = !!Number(can_access_user_panel);
      return { affectedRows: user ? 1 : 0 };
    }
    if (lowerSql.startsWith("update users set can_manage_leave")) {
      const [can_manage_leave, id] = params;
      const user = memoryDb.users.find(u => u.id === Number(id));
      if (user) user.can_manage_leave = !!Number(can_manage_leave);
      return { affectedRows: user ? 1 : 0 };
    }
    if (lowerSql.startsWith("update users set can_view_movement_claims")) {
      const [can_view_movement_claims, id] = params;
      const user = memoryDb.users.find(u => u.id === Number(id));
      if (user) user.can_view_movement_claims = !!Number(can_view_movement_claims);
      return { affectedRows: user ? 1 : 0 };
    }
    if (lowerSql.startsWith("update users set can_view_conveyance_claims")) {
      const [can_view_conveyance_claims, id] = params;
      const user = memoryDb.users.find(u => u.id === Number(id));
      if (user) user.can_view_conveyance_claims = !!Number(can_view_conveyance_claims);
      return { affectedRows: user ? 1 : 0 };
    }
    if (lowerSql.startsWith("update users set can_view_budget_module")) {
      const [can_view_budget_module, id] = params;
      const user = memoryDb.users.find(u => u.id === Number(id));
      if (user) user.can_view_budget_module = !!Number(can_view_budget_module);
      return { affectedRows: user ? 1 : 0 };
    }
    if (lowerSql.startsWith("update users set can_view_login_location = 0, can_access_user_panel = 0 where id")) {
      const id = Number(params[0]);
      const user = memoryDb.users.find(u => u.id === id);
      if (user) {
        user.can_view_login_location = false;
        user.can_access_user_panel = false;
      }
      return { affectedRows: user ? 1 : 0 };
    }
    if (lowerSql.startsWith("delete from users")) {
      const id = params[0];
      memoryDb.users = memoryDb.users.filter(u => u.id !== id);
      return { affectedRows: 1 };
    }
    if (lowerSql.startsWith("select id, role from users where id")) {
      const id = Number(params[0]);
      const user = memoryDb.users.find(u => u.id === id);
      return user ? [{ id: user.id, role: user.role }] : [];
    }
    if (lowerSql.startsWith("select id, role from users")) {
      return memoryDb.users.map((u: any) => ({ id: u.id, role: u.role }));
    }

    // ADMIN MODULE PERMISSIONS (Superadmin -> per-Admin Admin Panel tab access)
    if (lowerSql.startsWith("select module_key from admin_module_permissions where user_id")) {
      const userId = Number(params[0]);
      return memoryDb.adminModulePermissions.filter((r: any) => r.user_id === userId).map((r: any) => ({ module_key: r.module_key }));
    }
    if (lowerSql.startsWith("select user_id, module_key from admin_module_permissions")) {
      return memoryDb.adminModulePermissions.map((r: any) => ({ user_id: r.user_id, module_key: r.module_key }));
    }
    if (lowerSql.startsWith("delete from admin_module_permissions where user_id")) {
      const userId = Number(params[0]);
      memoryDb.adminModulePermissions = memoryDb.adminModulePermissions.filter((r: any) => r.user_id !== userId);
      return { affectedRows: 1 };
    }
    if (lowerSql.startsWith("insert into admin_module_permissions")) {
      const [userId, moduleKey] = params;
      memoryDb.adminModulePermissions.push({ user_id: Number(userId), module_key: moduleKey });
      return { insertId: memoryDb.adminModulePermissions.length };
    }

    // PROJECTS
    if (lowerSql.startsWith("select id, project_name from projects where id")) {
      const id = Number(params[0]);
      return memoryDb.projects.filter(p => p.id === id).map(p => ({ id: p.id, project_name: p.project_name }));
    }
    if (lowerSql.startsWith("select id from projects where id")) {
      const id = Number(params[0]);
      return memoryDb.projects.filter(p => p.id === id);
    }
    if (lowerSql.startsWith("select id from projects where lower(project_name)")) {
      const name = String(params[0]).toLowerCase();
      return memoryDb.projects.filter(p => p.project_name.toLowerCase() === name).map(p => ({ id: p.id }));
    }
    if (lowerSql.startsWith("select * from projects where id")) {
      const id = Number(params[0]);
      return memoryDb.projects.filter((p: any) => p.id === id);
    }
    if (lowerSql.startsWith("select * from projects")) {
      return [...memoryDb.projects];
    }
    if (lowerSql.startsWith("insert into projects")) {
      const [project_name, location_lat, location_lng, location_label, location_radius, created_by] = params;
      if (memoryDb.projects.some(p => p.project_name.toLowerCase() === project_name.toLowerCase())) {
        throw new Error("Project already exists");
      }
      const newId = memoryDb.projects.length + 1;
      const p = {
        id: newId,
        project_name,
        location_lat: location_lat ?? null,
        location_lng: location_lng ?? null,
        location_label: location_label ?? null,
        location_radius: location_radius ?? null,
        created_by,
        created_at: new Date()
      };
      memoryDb.projects.push(p);
      return { insertId: newId };
    }
    if (lowerSql.startsWith("update projects")) {
      const [project_name, location_lat, location_lng, location_label, location_radius, id] = params;
      const p: any = memoryDb.projects.find(x => x.id === Number(id));
      if (p) {
        p.project_name = project_name;
        p.location_lat = location_lat ?? null;
        p.location_lng = location_lng ?? null;
        p.location_label = location_label ?? null;
        p.location_radius = location_radius ?? null;
      }
      return { affectedRows: p ? 1 : 0 };
    }
    if (lowerSql.startsWith("delete from projects")) {
      const id = params[0];
      memoryDb.projects = memoryDb.projects.filter(p => p.id !== id);
      return { affectedRows: 1 };
    }

    // USER PROJECT PERMISSIONS
    if (lowerSql.startsWith("select id from user_project_permissions where user_id") && lowerSql.includes("project_id")) {
      const [userId, projectId] = params;
      return memoryDb.user_project_permissions.filter(p => p.user_id === userId && p.project_id === projectId);
    }
    if (lowerSql.startsWith("select project_id from user_project_permissions where user_id")) {
      const userId = params[0];
      return memoryDb.user_project_permissions.filter(p => p.user_id === userId);
    }
    if (lowerSql.startsWith("select * from user_project_permissions")) {
      return [...memoryDb.user_project_permissions];
    }
    if (lowerSql.startsWith("insert into user_project_permissions")) {
      const [user_id, project_id] = params;
      const exists = memoryDb.user_project_permissions.find(p => p.user_id === user_id && p.project_id === project_id);
      if (exists) return { insertId: exists.id };
      const newId = memoryDb.user_project_permissions.length + 1;
      memoryDb.user_project_permissions.push({ id: newId, user_id, project_id, created_at: new Date() });
      return { insertId: newId };
    }
    if (lowerSql.startsWith("delete from user_project_permissions where user_id")) {
      const userId = params[0];
      memoryDb.user_project_permissions = memoryDb.user_project_permissions.filter(p => p.user_id !== userId);
      return { affectedRows: 1 };
    }
    if (lowerSql.startsWith("delete from user_project_permissions where project_id")) {
      const projectId = params[0];
      memoryDb.user_project_permissions = memoryDb.user_project_permissions.filter(p => p.project_id !== projectId);
      return { affectedRows: 1 };
    }

    // MPR NUMBERS
    if (lowerSql.startsWith("select id from mpr_numbers where id")) {
      const id = Number(params[0]);
      return memoryDb.mpr_numbers.filter(m => m.id === id);
    }
    if (lowerSql.startsWith("select id, mpr_no from mpr_numbers where id")) {
      const id = Number(params[0]);
      return memoryDb.mpr_numbers.filter(m => m.id === id).map(m => ({ id: m.id, mpr_no: m.mpr_no }));
    }
    if (lowerSql.startsWith("select id from mpr_numbers where lower(mpr_no)")) {
      const name = String(params[0]).toLowerCase();
      return memoryDb.mpr_numbers.filter(m => m.mpr_no.toLowerCase() === name).map(m => ({ id: m.id }));
    }
    if (lowerSql.startsWith("select * from mpr_numbers")) {
      return [...memoryDb.mpr_numbers];
    }
    // Orphan check used by Budget delete — is this MRF No still used by ANY
    // budget_items row (i.e. another Budget's import), after this Budget's own rows
    // have already been removed?
    if (lowerSql.startsWith("select count(*) as cnt from budget_items where lower(mrf_no)")) {
      const mrfNo = String(params[0] || "").trim().toLowerCase();
      const cnt = memoryDb.budget_items.filter((it: any) => (it.mrf_no || "").trim().toLowerCase() === mrfNo).length;
      return [{ cnt }];
    }
    // Orphan check used by Budget delete — is this MPR No still referenced by any
    // entry (active or sitting in the Job Recycle bin) under a different Budget?
    if (lowerSql.startsWith("select count(*) as cnt from entries where mpr_id")) {
      const mprId = params[0];
      const cnt = memoryDb.entries.filter((e: any) => e.mpr_id === mprId).length;
      return [{ cnt }];
    }
    if (lowerSql.startsWith("insert into mpr_numbers")) {
      const [mpr_no, created_by] = params;
      if (memoryDb.mpr_numbers.some(m => m.mpr_no.toLowerCase() === mpr_no.toLowerCase())) {
        throw new Error("MPR Number already exists");
      }
      const newId = memoryDb.mpr_numbers.length + 1;
      const m = { id: newId, mpr_no, created_by, created_at: new Date() };
      memoryDb.mpr_numbers.push(m);
      return { insertId: newId };
    }
    if (lowerSql.startsWith("update mpr_numbers")) {
      const [mpr_no, id] = params;
      const m = memoryDb.mpr_numbers.find(x => x.id === id);
      if (m) m.mpr_no = mpr_no;
      return { affectedRows: m ? 1 : 0 };
    }
    if (lowerSql.startsWith("delete from mpr_numbers")) {
      const id = params[0];
      memoryDb.mpr_numbers = memoryDb.mpr_numbers.filter(m => m.id !== id);
      return { affectedRows: 1 };
    }

    // JOBS
    if (lowerSql.startsWith("select * from jobs where job_no")) {
      const jobNo = params[0];
      return memoryDb.jobs.filter(j => j.job_no.toLowerCase() === jobNo.toLowerCase());
    }
    if (lowerSql.startsWith("select * from jobs where id")) {
      const id = Number(params[0]);
      return memoryDb.jobs.filter(j => j.id === id);
    }
    if (lowerSql.startsWith("select * from jobs")) {
      return [...memoryDb.jobs];
    }
    if (lowerSql.startsWith("insert into jobs")) {
      const [job_no, job_duration, created_by, budget_id] = params;
      // Uniqueness is per user PER BUDGET (created_by, budget_id, job_no), not global —
      // mirrors the real DB's unique_user_budget_job_no key.
      const existing = memoryDb.jobs.find(
        (j: any) =>
          j.job_no.toLowerCase() === job_no.toLowerCase() &&
          j.created_by === created_by &&
          j.budget_id === budget_id
      );
      if (existing) return { insertId: existing.id };
      const newId = memoryDb.jobs.length + 1;
      const j = { id: newId, job_no, job_duration, created_by, budget_id, created_at: new Date() };
      memoryDb.jobs.push(j);
      return { insertId: newId };
    }

    // BUDGETS
    if (lowerSql.startsWith("select id from budgets where id")) {
      const id = Number(params[0]);
      return memoryDb.budgets.filter(b => b.id === id);
    }
    if (lowerSql.startsWith("select id, budget_name, created_by, created_at, original_filename")) {
      // Listing query — never sends the file bytes down, just whether one exists.
      return [...memoryDb.budgets]
        .sort((a, b) => b.id - a.id)
        .map(b => ({
          id: b.id,
          budget_name: b.budget_name,
          created_by: b.created_by,
          created_at: b.created_at,
          original_filename: b.original_filename || null,
          delivery_date_from: b.delivery_date_from || null,
          delivery_date_to: b.delivery_date_to || null,
          rate_approved_at: b.rate_approved_at || null,
          rate_approved_by: b.rate_approved_by || null,
          is_published: b.is_published ? 1 : 0,
          published_at: b.published_at || null,
          has_file: b.file_data ? 1 : 0
        }));
    }
    if (lowerSql.startsWith("select id, original_filename, file_mimetype, file_data from budgets")) {
      const id = Number(params[0]);
      const b = memoryDb.budgets.find(x => x.id === id);
      return b ? [{ id: b.id, original_filename: b.original_filename, file_mimetype: b.file_mimetype, file_data: b.file_data }] : [];
    }
    if (lowerSql.startsWith("select delivery_date_from, delivery_date_to from budgets")) {
      const id = Number(params[0]);
      const b = memoryDb.budgets.find(x => x.id === id);
      return b ? [{ delivery_date_from: b.delivery_date_from || null, delivery_date_to: b.delivery_date_to || null }] : [];
    }
    if (lowerSql.startsWith("select * from budgets")) {
      return [...memoryDb.budgets].sort((a, b) => b.id - a.id);
    }
    if (lowerSql.startsWith("insert into budgets")) {
      const [budget_name, created_by] = params;
      const newId = memoryDb.budgets.length + 1;
      const b = {
        id: newId,
        budget_name,
        created_by,
        original_filename: null,
        file_mimetype: null,
        file_data: null,
        delivery_date_from: null,
        delivery_date_to: null,
        is_published: 0,
        published_at: null,
        created_at: new Date()
      };
      memoryDb.budgets.push(b);
      return { insertId: newId };
    }
    if (lowerSql.startsWith("update budgets set is_published")) {
      const [is_published, published_at, id] = params;
      const b = memoryDb.budgets.find((x: any) => x.id === Number(id));
      if (b) {
        b.is_published = is_published;
        b.published_at = published_at;
      }
      return { affectedRows: b ? 1 : 0 };
    }
    if (lowerSql.startsWith("update budgets set original_filename")) {
      const [original_filename, file_mimetype, file_data, id] = params;
      const b = memoryDb.budgets.find(x => x.id === id);
      if (b) {
        b.original_filename = original_filename;
        b.file_mimetype = file_mimetype;
        b.file_data = file_data;
      }
      return { affectedRows: b ? 1 : 0 };
    }
    if (lowerSql.startsWith("update budgets set delivery_date_from")) {
      const [delivery_date_from, delivery_date_to, id] = params;
      const b = memoryDb.budgets.find(x => x.id === Number(id));
      if (b) {
        b.delivery_date_from = delivery_date_from || null;
        b.delivery_date_to = delivery_date_to || null;
      }
      return { affectedRows: b ? 1 : 0 };
    }
    if (lowerSql.startsWith("delete from budgets")) {
      const id = Number(params[0]);
      memoryDb.budgets = memoryDb.budgets.filter(b => b.id !== id);
      return { affectedRows: 1 };
    }

    // BUDGET ITEMS
    if (lowerSql.startsWith("select budget_id, count(*) as cnt from budget_items")) {
      const counts: Record<number, number> = {};
      memoryDb.budget_items.forEach(it => { counts[it.budget_id] = (counts[it.budget_id] || 0) + 1; });
      return Object.entries(counts).map(([budget_id, cnt]) => ({ budget_id: Number(budget_id), cnt }));
    }
    if (lowerSql.startsWith("select mrf_no from budget_items where budget_id = ? and lower(trim(project_name))")) {
      const budget_id = Number(params[0]);
      const projectName = String(params[1] || "").trim().toLowerCase();
      return memoryDb.budget_items
        .filter(
          it =>
            it.budget_id === budget_id &&
            it.mrf_no &&
            (it.project_name || "").trim().toLowerCase() === projectName
        )
        .map(it => ({ mrf_no: it.mrf_no }));
    }
    if (lowerSql.startsWith("select mrf_no from budget_items where budget_id")) {
      const budget_id = Number(params[0]);
      return memoryDb.budget_items.filter(it => it.budget_id === budget_id && it.mrf_no).map(it => ({ mrf_no: it.mrf_no }));
    }
    if (lowerSql.startsWith("select * from budget_items where budget_id")) {
      const budget_id = Number(params[0]);
      return memoryDb.budget_items.filter(it => it.budget_id === budget_id);
    }
    // Entry edit validation: confirm an Item Name (or a Project Name, for the MPR-No
    // scope check) belongs to the imported row for a given Budget + MRF No — used by
    // both PUT /api/entries/:id and the create-entry MPR-scope check.
    if (lowerSql.startsWith("select id from budget_items where budget_id") && lowerSql.includes("mrf_no")) {
      const [bid, mrfNo, thirdVal] = params;
      const matchDescription = lowerSql.includes("description");
      return memoryDb.budget_items
        .filter((it: any) =>
          it.budget_id === bid &&
          String(it.mrf_no || "").trim().toLowerCase() === String(mrfNo).trim().toLowerCase() &&
          (matchDescription
            ? String(it.description || "").trim().toLowerCase() === String(thirdVal).trim().toLowerCase()
            : String(it.project_name || "").trim().toLowerCase() === String(thirdVal).trim().toLowerCase())
        )
        .map((it: any) => ({ id: it.id }));
    }
    if (lowerSql.startsWith("select description from budget_items where lower(mrf_no) = lower(?)")) {
      const mprNo = String(params[0]).toLowerCase();
      const matches = memoryDb.budget_items.filter(it => (it.mrf_no || "").toLowerCase() === mprNo);
      if (matches.length === 0) return [];
      const latest = matches.reduce((a, b) => (b.id > a.id ? b : a));
      return [{ description: latest.description }];
    }
    if (lowerSql.startsWith("insert into budget_items")) {
      const [
        budget_id, sl_no, project_name, req_no, mrf_no, item_date, description, unit, specification,
        req_qty, po_qty, received_qty, balance_qty, entry_user, approved_date, app_user, site_sup_date
      ] = params;
      const newId = memoryDb.budget_items.length + 1;
      const item = {
        id: newId, budget_id, sl_no, project_name, req_no, mrf_no, item_date, description, unit, specification,
        req_qty, po_qty, received_qty, balance_qty, entry_user, approved_date, app_user, site_sup_date,
        created_at: new Date()
      };
      memoryDb.budget_items.push(item);
      return { insertId: newId };
    }
    if (lowerSql.startsWith("delete from budget_items")) {
      const budget_id = Number(params[0]);
      memoryDb.budget_items = memoryDb.budget_items.filter(it => it.budget_id !== budget_id);
      return { affectedRows: 1 };
    }

    // BUDGET SUBMISSIONS ("Submit Budget" lock — one row per (budget_id, user_id))
    if (lowerSql.startsWith("select budget_id from budget_submissions where user_id")) {
      const user_id = params[0];
      return memoryDb.budget_submissions.filter(s => s.user_id === user_id).map(s => ({ budget_id: s.budget_id }));
    }
    if (lowerSql.startsWith("select * from budget_submissions where budget_id") && lowerSql.includes("user_id")) {
      const [budget_id, user_id] = params;
      return memoryDb.budget_submissions.filter(s => s.budget_id === budget_id && s.user_id === user_id);
    }
    if (lowerSql.startsWith("insert into budget_submissions")) {
      const [budget_id, user_id] = params;
      const existing = memoryDb.budget_submissions.find(s => s.budget_id === budget_id && s.user_id === user_id);
      if (existing) return { insertId: existing.id };
      const newId = memoryDb.budget_submissions.length + 1;
      memoryDb.budget_submissions.push({ id: newId, budget_id, user_id, submitted_at: new Date() });
      return { insertId: newId };
    }
    if (lowerSql.startsWith("delete from budget_submissions where budget_id")) {
      const budget_id = Number(params[0]);
      memoryDb.budget_submissions = memoryDb.budget_submissions.filter(s => s.budget_id !== budget_id);
      return { affectedRows: 1 };
    }

    // ENTRIES — bulk wipe for a deleted Budget (must be checked BEFORE the generic
    // "delete from entries" id-based handler below, since that one's prefix would
    // otherwise swallow this query too).
    if (lowerSql.startsWith("delete from entries where budget_id")) {
      const budget_id = params[0];
      memoryDb.entries = memoryDb.entries.filter((e: any) => e.budget_id !== budget_id);
      return { affectedRows: 1 };
    }

    // ENTRIES
    if (lowerSql.includes("select e.mpr_id, m.mpr_no, j.job_no, e.job_name, p.project_name, e.entry_date")) {
      // Minimal system-wide MPR-usage lookup — deliberately excludes created_by /
      // user_name, mirrors the real SQL's column list exactly.
      return memoryDb.entries
        .filter((e: any) => !e.deleted_at)
        .map((e: any) => {
          const proj = memoryDb.projects.find((p: any) => p.id === e.project_id);
          const mpr = memoryDb.mpr_numbers.find((m: any) => m.id === e.mpr_id);
          const job = memoryDb.jobs.find((j: any) => j.id === e.job_id);
          return {
            mpr_id: e.mpr_id,
            mpr_no: mpr ? mpr.mpr_no : "Unknown",
            job_no: job ? job.job_no : "Unknown",
            job_name: e.job_name,
            project_name: proj ? proj.project_name : "Unknown",
            entry_date: e.entry_date
          };
        });
    }
    if (lowerSql.includes("select e.*, p.project_name, j.job_no, j.job_duration, m.mpr_no, u.name as user_name")) {
      // The same shape of query is used for both the active Reports listing
      // (WHERE e.deleted_at IS NULL) and the Admin's Job Recycle bin
      // (WHERE e.deleted_at IS NOT NULL) — branch on which one this is.
      const wantDeleted = lowerSql.includes("e.deleted_at is not null");
      // A non-admin's active listing is additionally scoped to their own entries
      // (AND e.created_by = ?), matching the real SQL's appended clause + param.
      const scopedToCreator = !wantDeleted && lowerSql.includes("and e.created_by = ?");
      const creatorId = scopedToCreator ? Number(params[0]) : null;
      const rows = memoryDb.entries
        .filter((e: any) => {
          if (wantDeleted ? !e.deleted_at : !!e.deleted_at) return false;
          if (scopedToCreator && e.created_by !== creatorId) return false;
          return true;
        })
        .map(e => {
          const proj = memoryDb.projects.find(p => p.id === e.project_id);
          const job = memoryDb.jobs.find(j => j.id === e.job_id);
          const mpr = memoryDb.mpr_numbers.find(m => m.id === e.mpr_id);
          const usr = memoryDb.users.find(u => u.id === e.created_by);
          const budget = memoryDb.budgets.find(b => b.id === e.budget_id);
          const deletedByUser = memoryDb.users.find(u => u.id === e.deleted_by);
          // Mirror the real SQL's LEFT JOIN onto budget_items (matched on budget_id +
          // MRF No + Description) so Specification, Req. Qty and the rest of the
          // imported Excel row are attached here too, not just when a real MySQL DB
          // is configured — this is what feeds the Qty column in Job Entry Details.
          const bi = memoryDb.budget_items.find(
            (it: any) =>
              it.budget_id === e.budget_id &&
              String(it.mrf_no || "").trim().toLowerCase() === String(mpr?.mpr_no || "").trim().toLowerCase() &&
              String(it.description || "").trim().toLowerCase() === String(e.item_name || "").trim().toLowerCase()
          );
          const budgetLocked = memoryDb.budget_submissions.some(
            (bs: any) => bs.budget_id === e.budget_id && bs.user_id === e.created_by
          );
          return {
            ...e,
            project_name: proj ? proj.project_name : "Unknown",
            job_no: job ? job.job_no : "Unknown",
            job_duration: job ? job.job_duration : "Unknown",
            mpr_no: mpr ? mpr.mpr_no : "Unknown",
            user_name: usr ? usr.name : "Unknown",
            budget_name: budget ? budget.budget_name : null,
            deleted_by_name: deletedByUser ? deletedByUser.name : null,
            bi_sl_no: bi ? bi.sl_no : null,
            bi_req_no: bi ? bi.req_no : null,
            bi_item_date: bi ? bi.item_date : null,
            specification: bi ? bi.specification : null,
            req_qty: bi ? bi.req_qty : null,
            unit: bi ? bi.unit : null,
            po_qty: bi ? bi.po_qty : null,
            received_qty: bi ? bi.received_qty : null,
            balance_qty: bi ? bi.balance_qty : null,
            bi_entry_user: bi ? bi.entry_user : null,
            bi_approved_date: bi ? bi.approved_date : null,
            bi_app_user: bi ? bi.app_user : null,
            site_sup_date: bi ? bi.site_sup_date : null,
            budget_locked: budgetLocked ? 1 : 0
          };
        });
      return wantDeleted
        ? rows.sort((a: any, b: any) => new Date(b.deleted_at).getTime() - new Date(a.deleted_at).getTime())
        : rows.sort((a: any, b: any) => (b.entry_date > a.entry_date ? 1 : b.entry_date < a.entry_date ? -1 : b.id - a.id));
    }
    if (lowerSql.startsWith("select * from entries where job_id") && lowerSql.includes("mpr_id")) {
      const [job_id, mpr_id] = params;
      return memoryDb.entries.filter(e => e.job_id === job_id && e.mpr_id === mpr_id);
    }
    // Single-entry fetch (Edit popup) joined with its Job's current job_duration and
    // its MPR No's current text — mirrors the real SQL join used in PUT /api/entries/:id.
    if (lowerSql.startsWith("select e.*, j.job_duration as current_job_duration")) {
      const id = Number(params[0]);
      const e = memoryDb.entries.find(en => en.id === id);
      if (!e) return [];
      const job = memoryDb.jobs.find(j => j.id === e.job_id);
      const mpr = memoryDb.mpr_numbers.find(m => m.id === e.mpr_id);
      return [{
        ...e,
        current_job_duration: job ? job.job_duration : null,
        current_mpr_no: mpr ? mpr.mpr_no : null
      }];
    }
    if (lowerSql.startsWith("select id from entries where job_id")) {
      const job_id = Number(params[0]);
      return memoryDb.entries.filter(e => e.job_id === job_id).map(e => ({ id: e.id }));
    }
    if (lowerSql.startsWith("select project_id, job_name from entries where job_id")) {
      const job_id = Number(params[0]);
      const match = memoryDb.entries.find((e: any) => e.job_id === job_id && !e.deleted_at);
      return match ? [{ project_id: match.project_id, job_name: match.job_name }] : [];
    }
    // MPR-No uniqueness check on edit — scoped PER BUDGET, excludes the entry being
    // edited itself and any deleted entry (a deleted entry frees up its MPR No for reuse).
    if (lowerSql.startsWith("select id from entries where mpr_id") && lowerSql.includes("id <>")) {
      const [mpr_id, budget_id, excludeId] = params;
      return memoryDb.entries
        .filter(
          (e: any) =>
            e.mpr_id === Number(mpr_id) &&
            e.budget_id === budget_id &&
            e.id !== Number(excludeId) &&
            !e.deleted_at
        )
        .map(e => ({ id: e.id }));
    }
    // MPR-No uniqueness check on create — scoped PER BUDGET, so the same MPR No is
    // free to reuse once it's under a different Budget.
    if (lowerSql.startsWith("select id from entries where mpr_id")) {
      const [mpr_id, budget_id] = params;
      return memoryDb.entries.filter(
        (e: any) => e.mpr_id === mpr_id && e.budget_id === budget_id && !e.deleted_at
      );
    }
    if (lowerSql.startsWith("select id from entries where budget_id") && lowerSql.includes("created_by")) {
      const [budget_id, created_by] = params;
      return memoryDb.entries.filter(e => e.budget_id === budget_id && e.created_by === created_by);
    }
    if (lowerSql.startsWith("select count(*) as cnt from entries where created_by")) {
      const created_by = params[0];
      const cnt = memoryDb.entries.filter(e => e.created_by === created_by).length;
      return [{ cnt }];
    }
    if (lowerSql.startsWith("select count(*) as cnt from jobs where created_by")) {
      const [created_by, budget_id] = params;
      // Scoped PER USER PER BUDGET — mirrors the real query below, which now filters
      // on both created_by and budget_id so the Job No sequence restarts per Budget.
      const cnt = memoryDb.jobs.filter(
        (j: any) => j.created_by === created_by && j.budget_id === budget_id
      ).length;
      return [{ cnt }];
    }
    if (lowerSql.startsWith("select count(*) as cnt from jobs")) {
      return [{ cnt: memoryDb.jobs.length }];
    }
    if (lowerSql.startsWith("insert into entries")) {
      const [entry_date, job_name, budget_id, project_id, job_id, mpr_id, item_name, delivery_date, created_by] = params;
      const newId = memoryDb.entries.length + 1;
      const ent = { id: newId, entry_date, job_name, budget_id, project_id, job_id, mpr_id, item_name, delivery_date, created_by, created_at: new Date() };
      memoryDb.entries.push(ent);
      return { insertId: newId };
    }
    if (lowerSql.startsWith("delete from entries")) {
      const id = Number(params[0]);
      memoryDb.entries = memoryDb.entries.filter((e: any) => e.id !== id);
      return { affectedRows: 1 };
    }
    // Soft delete — moves an entry into the Job Recycle bin instead of erasing it.
    if (lowerSql.startsWith("update entries set deleted_at = now()")) {
      const [deleted_by, id] = params;
      const e = memoryDb.entries.find((en: any) => en.id === Number(id));
      if (e) { e.deleted_at = new Date(); e.deleted_by = deleted_by; }
      return { affectedRows: e ? 1 : 0 };
    }
    // Restore out of the Job Recycle bin.
    if (lowerSql.startsWith("update entries set deleted_at = null")) {
      const [id] = params;
      const e = memoryDb.entries.find((en: any) => en.id === Number(id));
      if (e) { e.deleted_at = null; e.deleted_by = null; }
      return { affectedRows: e ? 1 : 0 };
    }
    // Recycle-bin lookups (SELECT id, deleted_at FROM entries WHERE id = ?) used by
    // the restore / permanent-delete routes.
    if (lowerSql.startsWith("select id, deleted_at from entries where id")) {
      const id = Number(params[0]);
      const e = memoryDb.entries.find((en: any) => en.id === id);
      return e ? [{ id: e.id, deleted_at: e.deleted_at || null }] : [];
    }
    if (lowerSql.startsWith("update entries set item_name")) {
      const [item_name, delivery_date, mpr_id, id] = params;
      const e = memoryDb.entries.find(en => en.id === Number(id));
      if (e) { e.item_name = item_name; e.delivery_date = delivery_date; e.mpr_id = mpr_id; }
      return { affectedRows: e ? 1 : 0 };
    }
    if (lowerSql.startsWith("update entries set job_name")) {
      const [job_name, job_id] = params;
      memoryDb.entries.filter(e => e.job_id === Number(job_id)).forEach(e => { e.job_name = job_name; });
      return { affectedRows: 1 };
    }

    // JOBS (edit)
    if (lowerSql.startsWith("update jobs set job_duration")) {
      const [job_duration, id] = params;
      const j = memoryDb.jobs.find(job => job.id === Number(id));
      if (j) j.job_duration = job_duration;
      return { affectedRows: j ? 1 : 0 };
    }
    // JOBS — bulk wipe for a deleted Budget.
    if (lowerSql.startsWith("delete from jobs where budget_id")) {
      const budget_id = params[0];
      memoryDb.jobs = memoryDb.jobs.filter((j: any) => j.budget_id !== budget_id);
      return { affectedRows: 1 };
    }

    // ENTRY EDIT HISTORY
    if (lowerSql.startsWith("insert into entry_edit_history")) {
      const [entry_id, edited_by, field_name, old_value, new_value] = params;
      const newId = memoryDb.entry_edit_history.length + 1;
      memoryDb.entry_edit_history.push({
        id: newId, entry_id: Number(entry_id), edited_by, field_name, old_value, new_value, edited_at: new Date()
      });
      return { insertId: newId };
    }
    if (lowerSql.startsWith("select h.*, u.name as editor_name") && lowerSql.includes("where h.entry_id")) {
      const entry_id = Number(params[0]);
      return memoryDb.entry_edit_history
        .filter((h: any) => h.entry_id === entry_id)
        .sort((a: any, b: any) => b.id - a.id)
        .map((h: any) => {
          const usr = memoryDb.users.find(u => u.id === h.edited_by);
          return { ...h, editor_name: usr ? usr.name : null };
        });
    }
    // System-wide edit log (no entry_id filter) — same shape as above but joined
    // across every entry, for the Admin Panel's "MPR Edit Log" tab.
    if (lowerSql.startsWith("select h.*, u.name as editor_name") && lowerSql.includes("j.job_no")) {
      return memoryDb.entry_edit_history
        .slice()
        .sort((a: any, b: any) => b.id - a.id)
        .map((h: any) => {
          const editor = memoryDb.users.find(u => u.id === h.edited_by);
          const entry = memoryDb.entries.find((e: any) => e.id === h.entry_id);
          const job = entry ? memoryDb.jobs.find((j: any) => j.id === entry.job_id) : null;
          const mpr = entry ? memoryDb.mpr_numbers.find((m: any) => m.id === entry.mpr_id) : null;
          const owner = entry ? memoryDb.users.find(u => u.id === entry.created_by) : null;
          return {
            ...h,
            editor_name: editor ? editor.name : null,
            job_no: job ? job.job_no : null,
            job_name: entry ? entry.job_name : null,
            mpr_id: entry ? entry.mpr_id : null,
            mpr_no: mpr ? mpr.mpr_no : null,
            item_name: entry ? entry.item_name : null,
            entry_owner_id: entry ? entry.created_by : null,
            entry_owner_name: owner ? owner.name : null
          };
        });
    }

    // ATTENDANCE (Remote Attendance — one row per user/project/day)
    if (lowerSql.startsWith("select * from attendance where user_id = ? and project_id = ? and attendance_date = ?")) {
      const [user_id, project_id, attendance_date] = params;
      return memoryDb.attendance.filter(
        (a: any) => a.user_id === user_id && a.project_id === project_id && a.attendance_date === attendance_date
      );
    }
    if (lowerSql.startsWith("select * from attendance where user_id = ? order by")) {
      const user_id = params[0];
      return memoryDb.attendance
        .filter((a: any) => a.user_id === user_id)
        .sort((a: any, b: any) => (a.attendance_date < b.attendance_date ? 1 : a.attendance_date > b.attendance_date ? -1 : b.id - a.id));
    }
    if (lowerSql.startsWith("select * from attendance")) {
      return [...memoryDb.attendance].sort((a: any, b: any) =>
        a.attendance_date < b.attendance_date ? 1 : a.attendance_date > b.attendance_date ? -1 : b.id - a.id
      );
    }
    if (lowerSql.startsWith("insert into attendance")) {
      const [user_id, project_id, attendance_date, check_in_lat, check_in_lng, check_in_distance_m, check_in_remarks] = params;
      const newId = memoryDb.attendance.length > 0 ? Math.max(...memoryDb.attendance.map((a: any) => a.id)) + 1 : 1;
      memoryDb.attendance.push({
        id: newId,
        user_id,
        project_id,
        attendance_date,
        check_in_at: new Date(),
        check_in_lat,
        check_in_lng,
        check_in_distance_m,
        check_in_remarks: check_in_remarks ?? null,
        check_out_at: null,
        check_out_lat: null,
        check_out_lng: null,
        check_out_distance_m: null,
        check_out_remarks: null,
        created_at: new Date()
      });
      return { insertId: newId };
    }
    if (lowerSql.startsWith("update attendance set check_in_at")) {
      const [check_in_lat, check_in_lng, check_in_distance_m, check_in_remarks, id] = params;
      const row = memoryDb.attendance.find((a: any) => a.id === id);
      if (row) {
        row.check_in_at = new Date();
        row.check_in_lat = check_in_lat;
        row.check_in_lng = check_in_lng;
        row.check_in_distance_m = check_in_distance_m;
        row.check_in_remarks = check_in_remarks ?? null;
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("update attendance set check_out_at")) {
      const [check_out_lat, check_out_lng, check_out_distance_m, check_out_remarks, id] = params;
      const row = memoryDb.attendance.find((a: any) => a.id === id);
      if (row) {
        row.check_out_at = new Date();
        row.check_out_lat = check_out_lat;
        row.check_out_lng = check_out_lng;
        row.check_out_distance_m = check_out_distance_m;
        row.check_out_remarks = check_out_remarks ?? null;
      }
      return { affectedRows: row ? 1 : 0 };
    }

    // EMPLOYEE TRACKING (background location pings from the APK)
    if (lowerSql.startsWith("insert into location_pings")) {
      const [user_id, lat, lng, accuracy_m, battery_pct, recorded_at] = params;
      const newId = memoryDb.location_pings.length > 0 ? Math.max(...memoryDb.location_pings.map((p: any) => p.id)) + 1 : 1;
      memoryDb.location_pings.push({
        id: newId,
        user_id,
        lat,
        lng,
        accuracy_m: accuracy_m ?? null,
        battery_pct: battery_pct ?? null,
        recorded_at: recorded_at ? new Date(recorded_at) : new Date(),
        created_at: new Date()
      });
      return { insertId: newId };
    }
    if (lowerSql.startsWith("select * from location_pings where user_id = ?")) {
      const user_id = params[0];
      return [...memoryDb.location_pings]
        .filter((p: any) => p.user_id === user_id)
        .sort((a: any, b: any) => (a.recorded_at < b.recorded_at ? 1 : -1));
    }
    if (lowerSql.startsWith("select * from location_pings")) {
      return [...memoryDb.location_pings].sort((a: any, b: any) => (a.recorded_at < b.recorded_at ? 1 : -1));
    }

    // NOTICES (Superadmin/Admin -> User login popup)
    if (lowerSql.startsWith("select * from notices where id")) {
      const id = Number(params[0]);
      return memoryDb.notices.filter((n: any) => n.id === id);
    }
    if (lowerSql.startsWith("select * from notices")) {
      return [...memoryDb.notices];
    }
    if (lowerSql.startsWith("insert into notices")) {
      const [title, content_html, lottie_json, lottie_url, target_type, is_active, created_by] = params;
      const newId = memoryDb.notices.length ? Math.max(...memoryDb.notices.map((n: any) => n.id)) + 1 : 1;
      memoryDb.notices.push({
        id: newId,
        title,
        content_html,
        lottie_json: lottie_json ?? null,
        lottie_url: lottie_url ?? null,
        target_type,
        is_active: is_active ? 1 : 0,
        created_by,
        created_at: new Date(),
        updated_at: new Date()
      });
      return { insertId: newId };
    }
    if (lowerSql.startsWith("update notices set title")) {
      const [title, content_html, lottie_json, lottie_url, target_type, id] = params;
      const row = memoryDb.notices.find((n: any) => n.id === Number(id));
      if (row) {
        row.title = title;
        row.content_html = content_html;
        row.lottie_json = lottie_json ?? null;
        row.lottie_url = lottie_url ?? null;
        row.target_type = target_type;
        row.updated_at = new Date();
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("update notices set is_active")) {
      const [is_active, id] = params;
      const row = memoryDb.notices.find((n: any) => n.id === Number(id));
      if (row) {
        row.is_active = is_active ? 1 : 0;
        row.updated_at = new Date();
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("delete from notices")) {
      const id = Number(params[0]);
      memoryDb.notices = memoryDb.notices.filter((n: any) => n.id !== id);
      memoryDb.noticeTargets = memoryDb.noticeTargets.filter((t: any) => t.notice_id !== id);
      memoryDb.noticeDismissals = memoryDb.noticeDismissals.filter((d: any) => d.notice_id !== id);
      return { affectedRows: 1 };
    }

    // EMPLOYEE DIRECTORY (Admin Panel -> Employees)
    if (lowerSql.startsWith("select * from all_employees where id")) {
      const id = Number(params[0]);
      return memoryDb.employees.filter((e: any) => e.id === id);
    }
    if (lowerSql.startsWith("select * from all_employees")) {
      return [...memoryDb.employees];
    }
    if (lowerSql.startsWith("insert into all_employees")) {
      // Column list is dynamic (core fields + EMPLOYEE_EXT_FIELDS + user_id),
      // built the same way in POST /api/employees — read the actual column
      // names out of the "INSERT INTO all_employees (...)" clause instead of
      // hardcoding positions, so this stays in sync automatically.
      const colsMatch = sql.match(/\(([^)]+)\)\s*values/i);
      const cols = colsMatch ? colsMatch[1].split(",").map((c) => c.trim()) : [];
      const newId = memoryDb.employees.length ? Math.max(...memoryDb.employees.map((e: any) => e.id)) + 1 : 1;
      const row: any = { id: newId, created_at: new Date() };
      cols.forEach((col, i) => {
        row[col] = col === "is_active" || (EMPLOYEE_BOOL_FIELDS as readonly string[]).includes(col)
          ? (params[i] ? 1 : 0)
          : params[i] ?? null;
      });
      memoryDb.employees.push(row);
      return { insertId: newId };
    }
    if (lowerSql.startsWith("update all_employees set")) {
      const setMatch = sql.match(/set\s+(.+?)\s+where/i);
      const cols = setMatch ? setMatch[1].split(",").map((c) => c.trim().split("=")[0].trim()) : [];
      const id = Number(params[params.length - 1]);
      const row = memoryDb.employees.find((e: any) => e.id === id);
      if (row) {
        cols.forEach((col, i) => {
          row[col] = col === "is_active" || (EMPLOYEE_BOOL_FIELDS as readonly string[]).includes(col)
            ? (params[i] ? 1 : 0)
            : params[i] ?? null;
        });
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("delete from all_employees")) {
      const id = Number(params[0]);
      memoryDb.employees = memoryDb.employees.filter((e: any) => e.id !== id);
      memoryDb.employeeSupervisors = memoryDb.employeeSupervisors.filter((s: any) => s.employee_id !== id && s.supervisor_id !== id);
      return { affectedRows: 1 };
    }

    // EMPLOYEE SUPERVISORS (Admin Panel -> Employees -> Edit -> Supervisor tab)
    if (lowerSql.startsWith("select es.id, es.employee_id")) {
      const employeeId = Number(params[0]);
      const rows = memoryDb.employeeSupervisors
        .filter((s: any) => s.employee_id === employeeId)
        .map((s: any) => {
          const sup = memoryDb.employees.find((e: any) => e.id === s.supervisor_id);
          return {
            id: s.id,
            employee_id: s.employee_id,
            supervisor_id: s.supervisor_id,
            effective_date: s.effective_date,
            is_direct: s.is_direct,
            supervisor_name: sup ? sup.name : "",
            supervisor_employee_code: sup ? sup.employee_id : null
          };
        })
        .sort((a: any, b: any) => (b.effective_date || "").localeCompare(a.effective_date || "") || b.id - a.id);
      return rows;
    }
    if (lowerSql.startsWith("select id from all_employees where id")) {
      const id = Number(params[0]);
      return memoryDb.employees.filter((e: any) => e.id === id).map((e: any) => ({ id: e.id }));
    }
    if (lowerSql.startsWith("insert into employee_supervisors")) {
      const [employee_id, supervisor_id, effective_date, is_direct] = params;
      const newId = memoryDb.employeeSupervisors.length ? Math.max(...memoryDb.employeeSupervisors.map((s: any) => s.id)) + 1 : 1;
      memoryDb.employeeSupervisors.push({
        id: newId,
        employee_id: Number(employee_id),
        supervisor_id: Number(supervisor_id),
        effective_date: effective_date ?? null,
        is_direct: is_direct ? 1 : 0,
        created_at: new Date()
      });
      return { insertId: newId };
    }
    if (lowerSql.startsWith("select id from employee_supervisors")) {
      const rowId = Number(params[0]);
      const employeeId = Number(params[1]);
      return memoryDb.employeeSupervisors.filter((s: any) => s.id === rowId && s.employee_id === employeeId).map((s: any) => ({ id: s.id }));
    }
    if (lowerSql.startsWith("update employee_supervisors set")) {
      const [supervisor_id, effective_date, is_direct, rowId] = params;
      const row = memoryDb.employeeSupervisors.find((s: any) => s.id === Number(rowId));
      if (row) {
        row.supervisor_id = Number(supervisor_id);
        row.effective_date = effective_date ?? null;
        row.is_direct = is_direct ? 1 : 0;
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("delete from employee_supervisors")) {
      const rowId = Number(params[0]);
      memoryDb.employeeSupervisors = memoryDb.employeeSupervisors.filter((s: any) => s.id !== rowId);
      return { affectedRows: 1 };
    }

    // NOTICE TARGETS ("specific" users a notice is aimed at)
    if (lowerSql.startsWith("select * from notice_targets where notice_id")) {
      const noticeId = Number(params[0]);
      return memoryDb.noticeTargets.filter((t: any) => t.notice_id === noticeId);
    }
    if (lowerSql.startsWith("select * from notice_targets")) {
      return [...memoryDb.noticeTargets];
    }
    if (lowerSql.startsWith("insert into notice_targets")) {
      const [notice_id, user_id] = params;
      memoryDb.noticeTargets.push({ id: memoryDb.noticeTargets.length + 1, notice_id: Number(notice_id), user_id: Number(user_id) });
      return { insertId: memoryDb.noticeTargets.length };
    }
    if (lowerSql.startsWith("delete from notice_targets where notice_id")) {
      const noticeId = Number(params[0]);
      memoryDb.noticeTargets = memoryDb.noticeTargets.filter((t: any) => t.notice_id !== noticeId);
      return { affectedRows: 1 };
    }

    // NOTICE DISMISSALS (per-user "seen/closed this notice")
    if (lowerSql.startsWith("select * from notice_dismissals where user_id")) {
      const userId = Number(params[0]);
      return memoryDb.noticeDismissals.filter((d: any) => d.user_id === userId);
    }
    if (lowerSql.startsWith("insert into notice_dismissals")) {
      const [notice_id, user_id] = params;
      const already = memoryDb.noticeDismissals.some((d: any) => d.notice_id === Number(notice_id) && d.user_id === Number(user_id));
      if (!already) {
        memoryDb.noticeDismissals.push({ id: memoryDb.noticeDismissals.length + 1, notice_id: Number(notice_id), user_id: Number(user_id), dismissed_at: new Date() });
      }
      return { insertId: memoryDb.noticeDismissals.length };
    }

    // MOVEMENT CLAIMS (point A -> point B travel check-in/check-out)
    if (lowerSql.startsWith("select * from claims where user_id = ? and status = 'open'")) {
      const userId = Number(params[0]);
      return memoryDb.claims.filter((c: any) => c.user_id === userId && c.status === "open");
    }
    if (lowerSql.startsWith("insert into claims")) {
      const [user_id, purpose, check_in_lat, check_in_lng, check_in_remarks] = params;
      const newId = memoryDb.claims.length > 0 ? Math.max(...memoryDb.claims.map((c: any) => c.id)) + 1 : 1;
      memoryDb.claims.push({
        id: newId,
        user_id: Number(user_id),
        purpose,
        status: "open",
        check_in_at: new Date(),
        check_in_lat,
        check_in_lng,
        check_in_remarks: check_in_remarks ?? null,
        check_out_at: null,
        check_out_lat: null,
        check_out_lng: null,
        check_out_remarks: null,
        distance_km: null,
        created_at: new Date()
      });
      return { insertId: newId };
    }
    if (lowerSql.startsWith("select * from claims where id = ?")) {
      const id = Number(params[0]);
      return memoryDb.claims.filter((c: any) => c.id === id);
    }
    if (lowerSql.startsWith("update claims set status = 'completed'")) {
      const [check_out_lat, check_out_lng, check_out_remarks, distance_km, id] = params;
      const row = memoryDb.claims.find((c: any) => c.id === Number(id));
      if (row) {
        row.status = "completed";
        row.check_out_at = new Date();
        row.check_out_lat = check_out_lat;
        row.check_out_lng = check_out_lng;
        row.check_out_remarks = check_out_remarks ?? null;
        row.distance_km = distance_km;
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("select * from claims where user_id = ? order by")) {
      const userId = Number(params[0]);
      return memoryDb.claims
        .filter((c: any) => c.user_id === userId)
        .sort((a: any, b: any) => b.id - a.id);
    }
    if (lowerSql.startsWith("select c.*, u.name as user_name from claims c")) {
      return memoryDb.claims
        .map((c: any) => {
          const u = memoryDb.users.find((x: any) => x.id === c.user_id);
          return { ...c, user_name: u ? u.name : null };
        })
        .sort((a: any, b: any) => b.id - a.id);
    }
    if (lowerSql.startsWith("delete from claims where id = ?")) {
      const id = Number(params[0]);
      const before = memoryDb.claims.length;
      memoryDb.claims = memoryDb.claims.filter((c: any) => c.id !== id);
      return { affectedRows: before !== memoryDb.claims.length ? 1 : 0 };
    }
    if (lowerSql.startsWith("select * from claims")) {
      return [...memoryDb.claims].sort((a: any, b: any) => b.id - a.id);
    }

    // APPROVAL WORKFLOW (global ordered chain + per-check-in/out requests)
    if (lowerSql.startsWith("select acs.*, u.name as user_name, u.role as user_role from approval_chain_steps")) {
      return [...memoryDb.approvalChainSteps]
        .sort((a: any, b: any) => a.step_order - b.step_order)
        .map((s: any) => {
          const u = memoryDb.users.find((x: any) => x.id === s.user_id);
          return { ...s, user_name: u ? u.name : null, user_role: u ? u.role : null };
        });
    }
    if (lowerSql.startsWith("delete from approval_chain_steps")) {
      const before = memoryDb.approvalChainSteps.length;
      memoryDb.approvalChainSteps = [];
      return { affectedRows: before };
    }
    if (lowerSql.startsWith("insert into approval_chain_steps")) {
      const [step_order, user_id] = params;
      const newId = memoryDb.approvalChainSteps.length > 0 ? Math.max(...memoryDb.approvalChainSteps.map((s: any) => s.id)) + 1 : 1;
      memoryDb.approvalChainSteps.push({ id: newId, step_order: Number(step_order), user_id: Number(user_id), created_at: new Date() });
      return { insertId: newId };
    }
    if (lowerSql.startsWith("insert into approval_requests")) {
      const newId = memoryDb.approvalRequests.length > 0 ? Math.max(...memoryDb.approvalRequests.map((r: any) => r.id)) + 1 : 1;
      // Two different callers share this "insert into approval_requests"
      // prefix with two different column/param shapes — matched here on
      // whether the SQL text mentions template_id, since a naive positional
      // destructure (as this branch used to do) silently reads whichever
      // fields happen to line up, corrupting total_steps for the Dynamic
      // Approval Engine path below (createTemplateApprovalRequest).
      if (lowerSql.includes("template_id")) {
        // createTemplateApprovalRequest (Dynamic Approval Engine, Part 3+6):
        // (source_type, event_type, source_id, requested_by, status, current_step,
        //  total_steps, actions_json, template_id, supervisor_step_user_id)
        // VALUES (?, 'submit', ?, ?, 'pending', 1, ?, '[]', ?, ?)
        const [source_type, source_id, requested_by, total_steps, template_id, supervisor_step_user_id] = params;
        memoryDb.approvalRequests.push({
          id: newId,
          source_type,
          event_type: "submit",
          source_id: Number(source_id),
          requested_by: Number(requested_by),
          status: "pending",
          current_step: 1,
          total_steps: Number(total_steps),
          actions_json: "[]",
          template_id: template_id === null || template_id === undefined ? null : Number(template_id),
          supervisor_step_user_id:
            supervisor_step_user_id === null || supervisor_step_user_id === undefined ? null : Number(supervisor_step_user_id),
          created_at: new Date(),
          updated_at: new Date()
        });
        return { insertId: newId };
      }
      // createApprovalRequest (OLD global chain):
      // (source_type, event_type, source_id, requested_by, status, current_step,
      //  total_steps, actions_json) VALUES (?, ?, ?, ?, 'pending', 1, ?, '[]')
      const [source_type, event_type, source_id, requested_by, total_steps] = params;
      memoryDb.approvalRequests.push({
        id: newId,
        source_type,
        event_type,
        source_id: Number(source_id),
        requested_by: Number(requested_by),
        status: "pending",
        current_step: 1,
        total_steps: Number(total_steps),
        actions_json: "[]",
        template_id: null,
        supervisor_step_user_id: null,
        created_at: new Date(),
        updated_at: new Date()
      });
      return { insertId: newId };
    }
    if (lowerSql.startsWith("select ar.*, u.name as requested_by_name from approval_requests")) {
      return [...memoryDb.approvalRequests]
        .sort((a: any, b: any) => b.id - a.id)
        .map((r: any) => {
          const u = memoryDb.users.find((x: any) => x.id === r.requested_by);
          return { ...r, requested_by_name: u ? u.name : null };
        });
    }
    if (lowerSql.startsWith("select * from approval_requests where id = ?")) {
      const id = Number(params[0]);
      return memoryDb.approvalRequests.filter((r: any) => r.id === id);
    }
    if (lowerSql.startsWith("select * from approval_requests where source_type = ?")) {
      const source_type = params[0];
      return memoryDb.approvalRequests.filter((r: any) => r.source_type === source_type);
    }
    if (lowerSql.startsWith("select id from approval_requests where source_type = 'user_claim' and source_id = ?")) {
      const sourceId = Number(params[0]);
      return memoryDb.approvalRequests
        .filter((r: any) => r.source_type === "user_claim" && Number(r.source_id) === sourceId)
        .map((r: any) => ({ id: r.id }));
    }
    if (lowerSql.startsWith("update approval_requests set status")) {
      const [status, current_step, actions_json, id] = params;
      const row = memoryDb.approvalRequests.find((r: any) => r.id === Number(id));
      if (row) {
        row.status = status;
        row.current_step = Number(current_step);
        row.actions_json = actions_json;
        row.updated_at = new Date();
      }
      return { affectedRows: row ? 1 : 0 };
    }

    // LEAVE BALANCES (Self Service -> Leave Management)
    if (lowerSql.startsWith("select id, name, role from users where role in")) {
      return memoryDb.users
        .filter((u: any) => u.role === "admin" || u.role === "user")
        .map((u: any) => ({ id: u.id, name: u.name, role: u.role }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
    }
    if (lowerSql.startsWith("select * from leave_balances where user_id")) {
      const userId = Number(params[0]);
      return memoryDb.leaveBalances.filter((b: any) => b.user_id === userId);
    }
    if (lowerSql.startsWith("select id from leave_balances where user_id")) {
      const userId = Number(params[0]);
      return memoryDb.leaveBalances.filter((b: any) => b.user_id === userId).map((b: any) => ({ id: b.id }));
    }
    if (lowerSql.startsWith("select * from leave_balances")) {
      return [...memoryDb.leaveBalances];
    }
    if (lowerSql.startsWith("insert into leave_balances")) {
      const [userId, casual, sick, lwp] = params;
      const newId = memoryDb.leaveBalances.length > 0 ? Math.max(...memoryDb.leaveBalances.map((b: any) => b.id)) + 1 : 1;
      memoryDb.leaveBalances.push({
        id: newId,
        user_id: Number(userId),
        casual_leave: Number(casual),
        sick_leave: Number(sick),
        leave_without_pay: Number(lwp),
        updated_at: new Date()
      });
      return { insertId: newId };
    }
    if (lowerSql.startsWith("update leave_balances set casual_leave")) {
      const [casual, sick, lwp, userId] = params;
      const row = memoryDb.leaveBalances.find((b: any) => b.user_id === Number(userId));
      if (row) {
        row.casual_leave = Number(casual);
        row.sick_leave = Number(sick);
        row.leave_without_pay = Number(lwp);
        row.updated_at = new Date();
      }
      return { affectedRows: row ? 1 : 0 };
    }

    // LEAVE APPLICATIONS (Self Service -> Leave Application)
    if (lowerSql.startsWith("select id, name from users where role in ('admin','superadmin')")) {
      return memoryDb.users
        .filter((u: any) => u.role === "admin" || u.role === "superadmin")
        .map((u: any) => ({ id: u.id, name: u.name }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
    }
    if (lowerSql.startsWith("select id, name from users where id !=")) {
      const excludeId = Number(params[0]);
      return memoryDb.users
        .filter((u: any) => u.id !== excludeId)
        .map((u: any) => ({ id: u.id, name: u.name }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
    }
    if (lowerSql.startsWith("insert into leave_applications")) {
      const [
        userId, leaveType, startDate, endDate, dayCount, isContinuous, isPrefix, isSuffix,
        isHalfDay, includeExtraWorkDates, isForeignLeave, purpose, relieverId
      ] = params;
      const newId = memoryDb.leaveApplications.length > 0
        ? Math.max(...memoryDb.leaveApplications.map((a: any) => a.id)) + 1
        : 1;
      // apply_date is CURDATE() in the real query (not a bound param) — mirror
      // that here as today's date-only string.
      const applyDate = new Date().toISOString().slice(0, 10);
      memoryDb.leaveApplications.push({
        id: newId,
        user_id: Number(userId),
        leave_type: leaveType,
        start_date: startDate,
        end_date: endDate,
        day_count: Number(dayCount),
        is_continuous: isContinuous ? 1 : 0,
        is_prefix: isPrefix ? 1 : 0,
        is_suffix: isSuffix ? 1 : 0,
        is_half_day: isHalfDay ? 1 : 0,
        include_extra_work_dates: includeExtraWorkDates ? 1 : 0,
        is_foreign_leave: isForeignLeave ? 1 : 0,
        purpose,
        approver_id: null,
        status: "pending",
        apply_date: applyDate,
        remarks: null,
        decided_by: null,
        decided_at: null,
        reliever_id: Number(relieverId),
        reliever_status: "pending",
        reliever_remarks: null,
        reliever_decided_by: null,
        reliever_decided_at: null,
        created_at: new Date()
      });
      return { insertId: newId };
    }
    if (lowerSql.startsWith("select la.*, u.name as approver_name, rv.name as reliever_name from leave_applications")) {
      const userId = Number(params[0]);
      const userMap = new Map<number, any>(memoryDb.users.map((u: any) => [u.id, u]));
      return memoryDb.leaveApplications
        .filter((a: any) => a.user_id === userId)
        .map((a: any) => ({
          ...a,
          approver_name: userMap.get(a.approver_id)?.name || null,
          reliever_name: userMap.get(a.reliever_id)?.name || null
        }))
        .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }
    if (lowerSql.startsWith("select * from leave_applications order by created_at desc")) {
      return [...memoryDb.leaveApplications].sort(
        (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    }
    if (lowerSql.startsWith("select * from leave_applications where id")) {
      const id = Number(params[0]);
      return memoryDb.leaveApplications.filter((a: any) => a.id === id);
    }
    if (lowerSql.startsWith("select * from leave_applications")) {
      return [...memoryDb.leaveApplications];
    }
    if (lowerSql.startsWith("select id, name, role from users") && !lowerSql.includes("where")) {
      return memoryDb.users.map((u: any) => ({ id: u.id, name: u.name, role: u.role }));
    }
    if (lowerSql.startsWith("update leave_applications set status")) {
      const [status, remarks, decidedBy, id] = params;
      const row = memoryDb.leaveApplications.find((a: any) => a.id === Number(id));
      if (row) {
        row.status = status;
        row.remarks = remarks;
        row.decided_by = Number(decidedBy);
        row.decided_at = new Date();
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("update leave_applications set reliever_status = 'approved'")) {
      const [remarks, relieverUserId, id] = params;
      const row = memoryDb.leaveApplications.find((a: any) => a.id === Number(id));
      if (row) {
        row.reliever_status = "approved";
        row.reliever_remarks = remarks;
        row.reliever_decided_by = Number(relieverUserId);
        row.reliever_decided_at = new Date();
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("update leave_applications set reliever_status = 'rejected'")) {
      const [remarks, relieverUserId, id] = params;
      const row = memoryDb.leaveApplications.find((a: any) => a.id === Number(id));
      if (row) {
        row.reliever_status = "rejected";
        row.reliever_remarks = remarks;
        row.reliever_decided_by = Number(relieverUserId);
        row.reliever_decided_at = new Date();
      }
      return { affectedRows: row ? 1 : 0 };
    }

    return [];
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

    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
      if (err) return res.status(403).json({ error: "Invalid or expired token" });
      req.user = user;
      next();
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

  // Superadmin-only actions: promoting/demoting a User <-> Admin, and setting which
  // Admin Panel modules a given Admin or User may access. Never granted through the
  // API — only the .env-seeded account (see seedAdminFromEnv) is ever a superadmin.
  const requireSuperAdmin = (req: any, res: any, next: any) => {
    if (!req.user || req.user.role !== "superadmin") {
      return res.status(403).json({ error: "Superadmin access required" });
    }
    next();
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
  registerUserManagementRoutes(app, { authenticateToken, requireAdmin, requireSuperAdmin, requireModule, queryDB, adminModuleKeys: ADMIN_MODULE_KEYS });

  // Departments (Admin Panel -> Departments) + Branches (Admin Panel ->
  // Branches) — kept in their own file (DepartmentsAndBranches.ts), same
  // reasoning as profileRoutes.ts/holidayRoutes.ts/Alerts.ts/UserManagement.ts
  // above.
  registerDepartmentsAndBranchesRoutes(app, { authenticateToken, requireAdmin, requireModule, queryDB });

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
  const requireConveyanceClaimAccess = async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Access token required" });
    if (req.user.role === "superadmin") return next();
    try {
      const rows: any = await queryDB("SELECT can_view_conveyance_claims FROM users WHERE id = ?", [req.user.id]);
      if (rows.length > 0 && !!Number(rows[0].can_view_conveyance_claims)) return next();
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

  // --- API Routes ---

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
        { id: user.id, email: user.email, username: user.username, role: user.role, name: user.name },
        JWT_SECRET,
        { expiresIn: "7d" }
      );

      res.json({
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          username: user.username,
          role: user.role,
          can_edit_delivery_date: user.can_edit_delivery_date === undefined ? true : !!Number(user.can_edit_delivery_date),
          can_job_edit: !!Number(user.can_job_edit),
          // Superadmin-granted (or implicit for the Superadmin itself): shows the
          // Remote Attendance Check In/Out card on THIS account's own Dashboard.
          // OFF by default — separate from the "attendance" Admin Panel module,
          // which is about reviewing everyone else's records, not this account's
          // own check-in ability.
          can_use_attendance: user.role === "superadmin" ? true : !!Number(user.can_use_attendance),
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
          // So the Admin Panel can show/hide tabs right after login, before any
          // other fetch. Empty for Users and for Superadmin (who has every module
          // implicitly, not through explicit grants).
          module_permissions: (user.role === "admin" || user.role === "user") ? await getAdminModules(user.id) : []
        }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Login failed" });
    }
  });

  app.get("/api/auth/me", authenticateToken, async (req: any, res) => {
    try {
      const users = await queryDB(
        "SELECT id, name, email, role, created_at, can_edit_delivery_date, can_job_edit, can_use_attendance, can_view_login_location, can_access_user_panel, can_manage_leave, can_view_movement_claims, can_view_conveyance_claims, can_use_tracking, can_view_budget_module, can_view_leave_summary FROM users WHERE id = ?",
        [req.user.id]
      );
      if (users.length === 0) return res.status(404).json({ error: "User not found" });
      const u = users[0];
      res.json({
        ...u,
        can_edit_delivery_date: u.can_edit_delivery_date === undefined ? true : !!Number(u.can_edit_delivery_date),
        can_job_edit: !!Number(u.can_job_edit),
        can_use_attendance: u.role === "superadmin" ? true : !!Number(u.can_use_attendance),
        can_use_tracking: u.role === "superadmin" ? true : !!Number(u.can_use_tracking),
        can_view_login_location: u.role === "superadmin" ? true : !!Number(u.can_view_login_location),
        can_access_user_panel: u.role === "admin" ? !!Number(u.can_access_user_panel) : false,
        can_manage_leave: u.role === "superadmin" ? true : !!Number(u.can_manage_leave),
        can_view_movement_claims: u.role === "superadmin" ? true : !!Number(u.can_view_movement_claims),
        can_view_conveyance_claims: u.role === "superadmin" ? true : !!Number(u.can_view_conveyance_claims),
        can_view_budget_module: u.role === "superadmin" ? true : u.can_view_budget_module === undefined ? true : !!Number(u.can_view_budget_module),
        can_view_leave_summary: u.role === "superadmin" ? true : !!Number(u.can_view_leave_summary),
        module_permissions: (u.role === "admin" || u.role === "user") ? await getAdminModules(u.id) : []
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2. Projects CRUD
  // Admins see every project. Regular users only see the projects the Admin has
  // explicitly granted them access to via user_project_permissions (Admin Panel ->
  // Users -> Manage Projects). A user with no permissions granted sees none yet.
  app.get("/api/projects", authenticateToken, async (req: any, res) => {
    try {
      const projects = await queryDB("SELECT * FROM projects ORDER BY project_name ASC");
      if (req.user.role === "admin" || req.user.role === "superadmin") {
        return res.json(projects);
      }
      const perms = await queryDB("SELECT project_id FROM user_project_permissions WHERE user_id = ?", [req.user.id]);
      const allowedIds = new Set(perms.map((p: any) => p.project_id));
      res.json(projects.filter((p: any) => allowedIds.has(p.id)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Every Project, unfiltered by user_project_permissions — used only by
  // Timesheet's "Correct Attendance" picker. A correction is always a request
  // (POST /api/attendance/corrections never checks user_project_permissions
  // either — see that handler), routed through the Approval Workflow same as
  // any other attendance correction, so gating the Project dropdown by
  // check-in permission just blocked Employees with no Project explicitly
  // granted from ever submitting one — the dropdown looked empty ("no
  // project select") even though the request would have gone through
  // approval like normal. Any signed-in account may read this list.
  app.get("/api/projects/all", authenticateToken, async (req: any, res) => {
    try {
      const projects = await queryDB("SELECT * FROM projects ORDER BY project_name ASC");
      res.json(projects);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Location fields are optional — a project can be created/edited without ever
  // marking a spot on the map. lat/lng are validated together (both-or-neither,
  // both finite numbers in a real coordinate range) so a bad payload can't save a
  // half-set pin; the free-text label is trimmed and capped, and dropped entirely
  // if lat/lng are absent.
  function parseProjectLocation(body: any): { lat: number | null; lng: number | null; label: string | null; radius: number | null } | { error: string } {
    const hasLat = body.location_lat !== undefined && body.location_lat !== null && body.location_lat !== "";
    const hasLng = body.location_lng !== undefined && body.location_lng !== null && body.location_lng !== "";
    if (!hasLat && !hasLng) return { lat: null, lng: null, label: null, radius: null };
    if (hasLat !== hasLng) return { error: "Both latitude and longitude are required to set a location" };
    const lat = Number(body.location_lat);
    const lng = Number(body.location_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { error: "Invalid map location coordinates" };
    }
    const label = typeof body.location_label === "string" ? body.location_label.trim().slice(0, 255) || null : null;

    let radius: number | null = null;
    const hasRadius = body.location_radius !== undefined && body.location_radius !== null && body.location_radius !== "";
    if (hasRadius) {
      const r = Number(body.location_radius);
      if (!Number.isFinite(r) || r < 10 || r > 50000) {
        return { error: "Radius must be between 10 and 50,000 meters" };
      }
      radius = Math.round(r);
    }
    return { lat, lng, label, radius };
  }

  app.post("/api/projects", authenticateToken, requireAdmin, requireModule("projects"), async (req: any, res) => {
    try {
      const { project_name } = req.body;
      if (!project_name) return res.status(400).json({ error: "Project name is required" });
      const location = parseProjectLocation(req.body);
      if ("error" in location) return res.status(400).json({ error: location.error });

      const result = await queryDB(
        "INSERT INTO projects (project_name, location_lat, location_lng, location_label, location_radius, created_by) VALUES (?, ?, ?, ?, ?, ?)",
        [project_name.trim(), location.lat, location.lng, location.label, location.radius, req.user.id]
      );
      res.json({
        id: result.insertId,
        project_name: project_name.trim(),
        location_lat: location.lat,
        location_lng: location.lng,
        location_label: location.label,
        location_radius: location.radius
      });
    } catch (err: any) {
      if (err.code === "ER_DUP_ENTRY" || err.message?.includes("already exists")) {
        return res.status(400).json({ error: "Project already exists" });
      }
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/projects/:id", authenticateToken, requireAdmin, requireModule("projects"), async (req, res) => {
    try {
      const { id } = req.params;
      const { project_name } = req.body;
      if (!project_name) return res.status(400).json({ error: "Project name is required" });
      const location = parseProjectLocation(req.body);
      if ("error" in location) return res.status(400).json({ error: location.error });

      await queryDB(
        "UPDATE projects SET project_name = ?, location_lat = ?, location_lng = ?, location_label = ?, location_radius = ? WHERE id = ?",
        [project_name.trim(), location.lat, location.lng, location.label, location.radius, id]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/projects/:id", authenticateToken, requireAdmin, requireModule("projects"), async (req, res) => {
    try {
      const { id } = req.params;
      await queryDB("DELETE FROM user_project_permissions WHERE project_id = ?", [id]);
      await queryDB("DELETE FROM projects WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

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
    getHolidayMap
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

  app.post("/api/tracking/ping", authenticateToken, requireTrackingAccess, async (req: any, res) => {
    try {
      const lat = Number(req.body.lat);
      const lng = Number(req.body.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: "lat/lng are required." });
      }
      const accuracy_m = req.body.accuracy_m != null && Number.isFinite(Number(req.body.accuracy_m)) ? Math.round(Number(req.body.accuracy_m)) : null;
      const battery_pct = req.body.battery_pct != null && Number.isFinite(Number(req.body.battery_pct)) ? Math.round(Number(req.body.battery_pct)) : null;
      const recorded_at = req.body.recorded_at ? new Date(req.body.recorded_at) : new Date();
      await queryDB(
        "INSERT INTO location_pings (user_id, lat, lng, accuracy_m, battery_pct, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
        [req.user.id, lat, lng, accuracy_m, battery_pct, recorded_at]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Live board (Admin Panel -> Employee Tracking): the SINGLE most recent ping
  // per user, plus how long ago it was — this is the "where is everyone right
  // now" map, not a history. Only users with at least one ping ever show up.
  app.get("/api/tracking/live", authenticateToken, requireAdmin, requireModule("tracking"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM location_pings", []);
      const users = await queryDB("SELECT id, name, email, role FROM users", []);
      const userMap = new Map<number, any>(users.map((u: any) => [u.id, u]));
      const latestByUser = new Map<number, any>();
      for (const r of rows) {
        const existing = latestByUser.get(r.user_id);
        if (!existing || new Date(r.recorded_at).getTime() > new Date(existing.recorded_at).getTime()) {
          latestByUser.set(r.user_id, r);
        }
      }
      const result = Array.from(latestByUser.values())
        .map((r: any) => ({
          ...r,
          user_name: userMap.get(r.user_id)?.name || null,
          user_email: userMap.get(r.user_id)?.email || null
        }))
        .sort((a: any, b: any) => (a.recorded_at < b.recorded_at ? 1 : -1));
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Path history for ONE user (Admin Panel -> Employee Tracking -> click a user
  // -> "View path today"), optionally bounded by from/to — lets an Admin/
  // Superadmin play back where that user actually went, not just their latest dot.
  app.get("/api/tracking/history", authenticateToken, requireAdmin, requireModule("tracking"), async (req: any, res) => {
    try {
      const user_id = req.query.user_id ? Number(req.query.user_id) : null;
      if (!user_id) return res.status(400).json({ error: "user_id is required" });
      const rows = await queryDB("SELECT * FROM location_pings WHERE user_id = ? ORDER BY recorded_at DESC", [user_id]);
      const from = req.query.from ? String(req.query.from) : null;
      const to = req.query.to ? String(req.query.to) : null;
      // Time-of-day window (HH:MM, 24h), independent of the from/to DATE filter
      // above — e.g. from=2026-09-01&to=2026-09-30&from_time=09:00&to_time=18:00
      // narrows a report to "office hours" across that whole month, for
      // "where was this employee between X and Y" style reports. from_time >
      // to_time (e.g. 22:00 -> 06:00) is treated as an overnight window that
      // wraps past midnight rather than an always-empty one.
      const from_time = req.query.from_time ? String(req.query.from_time) : null;
      const to_time = req.query.to_time ? String(req.query.to_time) : null;
      const filtered = rows.filter((r: any) => {
        const iso = new Date(r.recorded_at).toISOString();
        const day = iso.slice(0, 10);
        if (from && day < from) return false;
        if (to && day > to) return false;
        if (from_time || to_time) {
          const hm = iso.slice(11, 16); // "HH:MM"
          if (from_time && to_time) {
            const overnight = from_time > to_time;
            const inWindow = overnight ? (hm >= from_time || hm <= to_time) : (hm >= from_time && hm <= to_time);
            if (!inWindow) return false;
          } else if (from_time && hm < from_time) {
            return false;
          } else if (to_time && hm > to_time) {
            return false;
          }
        }
        return true;
      });
      // Was capped at 500 — fine for a quick "view path today" playback, but a
      // report spanning a wider date/time range shouldn't silently lose points.
      // At one ping every 5-10 min, 5000 rows covers roughly a month before
      // truncating.
      res.json(filtered.slice(0, 5000));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2b-2. Office Attendance (ZKTeco) — raw biometric punches pulled automatically
  // off the office terminals by zkSync.ts every 5 minutes, kept in
  // zk_attendance_logs and mapped to the company roster via
  // all_employees.zk_device_pin. Deliberately separate from the project-based
  // `attendance` (Remote Attendance) table above — no GPS/project involved here.
  app.get("/api/zk-devices", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM zk_devices ORDER BY name", []);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/zk-devices", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      const { name, ip_address, port } = req.body;
      if (!name || !ip_address) return res.status(400).json({ error: "name and ip_address are required" });
      const result: any = await queryDB(
        "INSERT INTO zk_devices (name, ip_address, port) VALUES (?, ?, ?)",
        [name, ip_address, port || 4370]
      );
      res.json({ id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/zk-devices/:id", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      await queryDB("DELETE FROM zk_devices WHERE id = ?", [req.params.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manual "Sync Now" button on the Office Attendance tab — pulls every active
  // device immediately instead of waiting for the next 5-minute cron tick.
  app.post("/api/zk-devices/sync-now", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      const results = await syncAllZkDevices(dbPool);
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manual "Sync" on a single device badge — pulls just that one device
  // immediately, without waiting on (or blocking on) the others. Reuses the
  // exact same syncZkDevice() the all-device sync-now uses per device, just
  // called once instead of Promise.all'd across every active device.
  app.post("/api/zk-devices/:id/sync-now", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      const rows: any = await queryDB("SELECT * FROM zk_devices WHERE id = ?", [req.params.id]);
      const device = rows[0];
      if (!device) return res.status(404).json({ error: "Device not found" });
      const result = await syncZkDevice(dbPool, device);
      res.json({ device: device.name, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Map a roster employee to their ZKTeco device PIN (Admin Panel -> Employees).
  app.put("/api/employees/:id/zk-pin", authenticateToken, requireAdmin, requireModule("employees"), async (req: any, res) => {
    try {
      const { zk_device_pin } = req.body;
      await queryDB("UPDATE all_employees SET zk_device_pin = ? WHERE id = ?", [zk_device_pin || null, req.params.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Office Attendance report — one row per employee per day: first punch of the
  // day = Check In, last punch = Check Out, plus the raw punch count so an
  // Admin can spot a likely missed punch (an odd count).
  app.get("/api/office-attendance", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      const dateFrom = req.query.from ? String(req.query.from) : todayInDhaka();
      const dateTo = req.query.to ? String(req.query.to) : todayInDhaka();

      // Raw punches for the range, one row per punch. Aggregation now
      // happens below in JS (not in SQL) so the debounce logic is easy to
      // read and adjust.
      const rawRows = await queryDB(
        `SELECT
           e.id AS employee_id, e.name, e.designation, e.department,
           DATE(l.punch_time) AS attendance_date,
           l.punch_time
         FROM zk_attendance_logs l
         JOIN all_employees e ON e.zk_device_pin = l.device_user_pin
         WHERE DATE(l.punch_time) BETWEEN ? AND ?
         ORDER BY e.id, DATE(l.punch_time), l.punch_time`,
        [dateFrom, dateTo]
      );

      // 2 minutes covers a slow/retried scan comfortably. Raise it if a
      // particular device's sensor needs more attempts; lower it only if
      // genuinely-quick legitimate in/out pairs are getting collapsed
      // (unusual, but possible for someone stepping out very briefly).
      const DEBOUNCE_SECONDS = 120;

      const groups = new Map<string, { meta: any; kept: Date[] }>();
      for (const row of rawRows as any[]) {
        const key = `${row.employee_id}|${row.attendance_date}`;
        let g = groups.get(key);
        if (!g) {
          g = { meta: row, kept: [] };
          groups.set(key, g);
        }
        const t = new Date(row.punch_time);
        const lastKept = g.kept[g.kept.length - 1];
        if (!lastKept || (t.getTime() - lastKept.getTime()) / 1000 >= DEBOUNCE_SECONDS) {
          g.kept.push(t);
        }
        // else: within the debounce window of the previous kept punch —
        // same physical tap, skipped.
      }

      const rows = Array.from(groups.values())
        .map(({ meta, kept }) => ({
          employee_id: meta.employee_id,
          name: meta.name,
          designation: meta.designation,
          department: meta.department,
          attendance_date: meta.attendance_date,
          // Same COUNT(*) > 1 guard as before: a day with only one KEPT tap
          // so far (typically today, before the person has punched Out)
          // must report check_out_at as NULL rather than repeating the
          // Check In time.
          check_in_at: kept[0] ?? null,
          check_out_at: kept.length > 1 ? kept[kept.length - 1] : null,
          punch_count: kept.length
        }))
        .sort((a, b) => {
          const ad = new Date(a.attendance_date).getTime();
          const bd = new Date(b.attendance_date).getTime();
          if (ad !== bd) return bd - ad; // newest date first
          return String(a.name).localeCompare(String(b.name));
        });

      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  // 2c. Movement Claims — a free-form (no fixed Project geofence) point A -> point
  // B travel check-in/check-out: a User checks in with a Purpose (why/where
  // they're heading out for office work), then later checks out once they reach
  // or finish there. Used for TA/DA-style reimbursement review in the Admin
  // Panel's Movement Claims tab (gated per-Admin like every other module — a
  // Superadmin always sees it). Only ONE claim per User may be 'open' at a time.
  function parseClaimCoords(body: any): { lat: number; lng: number; remarks: string | null } | { error: string } {
    const lat = Number(body.latitude);
    const lng = Number(body.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { error: "Couldn't read your current location. Please allow location access and try again." };
    }
    const remarks = typeof body.remarks === "string" ? body.remarks.trim().slice(0, 1000) || null : null;
    return { lat, lng, remarks };
  }

  app.post("/api/claims/check-in", authenticateToken, requireMovementClaimAccess, async (req: any, res) => {
    try {
      const purpose = typeof req.body?.purpose === "string" ? req.body.purpose.trim().slice(0, 255) : "";
      if (!purpose) return res.status(400).json({ error: "Please describe where/why you're going." });
      const parsed = parseClaimCoords(req.body || {});
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      const { lat, lng, remarks } = parsed;

      const openExisting = await queryDB("SELECT * FROM claims WHERE user_id = ? AND status = 'open'", [req.user.id]);
      if (openExisting.length > 0) {
        return res.status(400).json({ error: "You already have an open claim — check out of it before starting a new one." });
      }

      const result = await queryDB(
        "INSERT INTO claims (user_id, purpose, status, check_in_at, check_in_lat, check_in_lng, check_in_remarks) VALUES (?, ?, 'open', NOW(), ?, ?, ?)",
        [req.user.id, purpose, lat, lng, remarks]
      );
      // Movement Claims are never routed through the Approval Chain — a User's
      // Check In/Out here needs no Admin/Approver sign-off (unlike Remote
      // Attendance above, which still does). See attachApprovalStatuses: with no
      // approval_requests row ever created for source_type 'claim', it always
      // resolves check_in_approval/check_out_approval to null, and ApprovalBadge
      // already renders nothing for a null approval — no UI change needed there.
      res.status(201).json({ success: true, id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/claims/:id/check-out", authenticateToken, requireMovementClaimAccess, async (req: any, res) => {
    try {
      const { id } = req.params;
      const parsed = parseClaimCoords(req.body || {});
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      const { lat, lng, remarks } = parsed;

      const rows = await queryDB("SELECT * FROM claims WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Claim not found." });
      const claim = rows[0];
      if (Number(claim.user_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: "This claim doesn't belong to you." });
      }
      if (claim.status !== "open") {
        return res.status(400).json({ error: "This claim has already been checked out." });
      }

      const distanceKm = Number(
        (haversineMeters(Number(claim.check_in_lat), Number(claim.check_in_lng), lat, lng) / 1000).toFixed(2)
      );

      await queryDB(
        "UPDATE claims SET status = 'completed', check_out_at = NOW(), check_out_lat = ?, check_out_lng = ?, check_out_remarks = ?, distance_km = ? WHERE id = ?",
        [lat, lng, remarks, distanceKm, id]
      );
      // No Approval Chain for Movement Claims — see the matching note on check-in above.
      res.json({ success: true, distance_km: distanceKm });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The calling user's own currently-open claim (if any) — lets the User Panel
  // show the right Check In / Check Out button state on load/refresh.
  app.get("/api/claims/status", authenticateToken, requireMovementClaimAccess, async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM claims WHERE user_id = ? AND status = 'open'", [req.user.id]);
      res.json(rows[0] || null);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The calling user's own claim history, most recent first.
  app.get("/api/claims/mine", authenticateToken, requireMovementClaimAccess, async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM claims WHERE user_id = ? ORDER BY id DESC", [req.user.id]);
      res.json(rows.slice(0, 200));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The calling user's own completed Movement Claims that haven't been referenced
  // by a Conveyance Bill Claim yet (user_claim_references) and haven't already
  // been pulled directly into an official Bill by an Admin either
  // (conveyance_bill_items.claim_id) — powers the "Reference Check In/Out" picker
  // in the New Conveyance Claim form. Each check-in/out can only ever be
  // referenced/billed ONCE.
  app.get("/api/claims/available", authenticateToken, requireMovementClaimAccess, async (req: any, res) => {
    try {
      const rows = await queryDB(
        `SELECT c.* FROM claims c
          WHERE c.user_id = ? AND c.status = 'completed'
            AND NOT EXISTS (SELECT 1 FROM conveyance_bill_items i WHERE i.claim_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM user_claim_references r WHERE r.claim_id = c.id)
          ORDER BY c.check_in_at DESC`,
        [req.user.id]
      );
      res.json(rows.map((r: any) => ({ ...r, distance_km: r.distance_km !== null ? Number(r.distance_km) : null })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // System-wide claim list for the Superadmin's (or a granted Admin's) Movement
  // Claims tab — every User's check-ins/outs, filterable by user/date, for
  // TA/DA-style reimbursement review.
  app.get("/api/claims", authenticateToken, requireAdmin, requireModule("claims"), async (req: any, res) => {
    try {
      const rows = await queryDB(
        "SELECT c.*, u.name AS user_name FROM claims c LEFT JOIN users u ON u.id = c.user_id ORDER BY c.id DESC"
      );
      const user_id = req.query.user_id ? Number(req.query.user_id) : null;
      const from = req.query.from ? String(req.query.from) : null;
      const to = req.query.to ? String(req.query.to) : null;
      const status = req.query.status ? String(req.query.status) : null;

      const filtered = rows.filter((r: any) => {
        if (user_id && Number(r.user_id) !== user_id) return false;
        if (status && r.status !== status) return false;
        const dateOnly = toDateOnlyString(r.check_in_at);
        if (from && dateOnly && dateOnly < from) return false;
        if (to && dateOnly && dateOnly > to) return false;
        return true;
      });

      const withApprovals = filtered.slice(0, 1000);
      res.json(withApprovals);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin cleanup — remove a mistaken/duplicate claim entirely (not a soft delete,
  // since a claim carries no downstream data the way an MPR Entry does).
  app.delete("/api/claims/:id", authenticateToken, requireAdmin, requireModule("claims"), async (req, res) => {
    try {
      const { id } = req.params;
      const result = await queryDB("DELETE FROM claims WHERE id = ?", [id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: "Claim not found" });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Payroll Module (Self Service -> Payroll / Admin Panel -> Payroll) — full
  // Salary Structure / Employee Advances / Payroll run workflow, kept in its
  // own file (PayrollRoutes.ts) from the start. Permission-gated like every
  // other module: requireModule('payroll') lets a Superadmin through
  // unconditionally and otherwise requires the 'payroll' grant in
  // admin_module_permissions (Admin Panel -> Users -> Module Access);
  // requireAdmin is layered in front of it the same way every other
  // Admin-Panel-gated module route in this file does.
  registerPayrollRoutes(app, {
    authenticateToken,
    requireAdmin,
    requireModule,
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
    userClaimCategories: USER_CLAIM_CATEGORIES
  });

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
    queryDB,
    getApprovalChain,
    performApprovalAction,
    toDateOnlyString,
    attachApprovalStatuses
  });

  // 2d. Notices — Superadmin/Admin composes a popup (title + text/HTML + an
  // optional custom Lottie animation) that shows to a User right after they log
  // in. Gated behind the "notices" Admin Panel module, same as every other tab.
  const parseJsonBody = <T,>(value: any): T | null => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "object") return value as T;
    try {
      return JSON.parse(String(value));
    } catch {
      return null;
    }
  };

  // Minimal recipient list for the "Specific Users" target picker — every plain
  // 'user' account (not Admins/Superadmins, who never see the popup). Deliberately
  // its own lightweight route rather than reusing GET /api/users, so an Admin who
  // only has the "notices" module (not "users") can still pick recipients.
  app.get("/api/notices/recipients", authenticateToken, requireAdmin, requireModule("notices"), async (req, res) => {
    try {
      const rows = await queryDB("SELECT * FROM users");
      res.json(
        rows
          .filter((u: any) => u.role === "user")
          .map((u: any) => ({ id: u.id, name: u.name, email: u.email || null, username: u.username || null }))
          .sort((a: any, b: any) => a.name.localeCompare(b.name))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Every Notice an Admin/Superadmin has created, newest first, with its target
  // users (for 'specific' ones) and who created it — for the Admin Panel -> Notices
  // management list.
  app.get("/api/notices", authenticateToken, requireAdmin, requireModule("notices"), async (req, res) => {
    try {
      const notices = await queryDB("SELECT * FROM notices");
      const targets = await queryDB("SELECT * FROM notice_targets");
      const users = await queryDB("SELECT id, name FROM users");
      const userMap = new Map<number, any>(users.map((u: any) => [u.id, u]));

      const sorted = [...notices].sort((a: any, b: any) => (a.id < b.id ? 1 : -1));
      res.json(
        sorted.map((n: any) => {
          const targetUserIds = targets.filter((t: any) => t.notice_id === n.id).map((t: any) => t.user_id);
          return {
            id: n.id,
            title: n.title,
            content_html: n.content_html,
            lottie_json: n.lottie_json || null,
            lottie_url: n.lottie_url || null,
            target_type: n.target_type,
            is_active: !!Number(n.is_active),
            created_by: n.created_by,
            created_by_name: userMap.get(n.created_by)?.name || null,
            created_at: n.created_at,
            updated_at: n.updated_at,
            target_user_ids: targetUserIds,
            target_users: targetUserIds.map((id: number) => ({ id, name: userMap.get(id)?.name || "Unknown" }))
          };
        })
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/notices", authenticateToken, requireAdmin, requireModule("notices"), async (req: any, res) => {
    try {
      const { title, content_html, lottie_json, lottie_url, target_type, target_user_ids, is_active } = req.body;
      if (!title || !String(title).trim()) return res.status(400).json({ error: "Title is required" });
      if (!content_html || !String(content_html).trim()) return res.status(400).json({ error: "Notice content is required" });
      const resolvedTargetType = target_type === "specific" ? "specific" : "all";
      // A pasted Lottie animation must be valid JSON, or it silently fails to
      // render for the User later — validated (and re-stringified) here rather
      // than trusted straight from the client.
      let lottieJsonStr: string | null = null;
      if (lottie_json && String(lottie_json).trim()) {
        const parsed = parseJsonBody(lottie_json);
        if (!parsed) return res.status(400).json({ error: "The pasted Lottie animation isn't valid JSON." });
        lottieJsonStr = JSON.stringify(parsed);
      }
      const lottieUrlStr = lottie_url && String(lottie_url).trim() ? String(lottie_url).trim() : null;

      const result = await queryDB(
        "INSERT INTO notices (title, content_html, lottie_json, lottie_url, target_type, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [String(title).trim(), String(content_html), lottieJsonStr, lottieUrlStr, resolvedTargetType, is_active === false ? 0 : 1, req.user.id]
      );
      const noticeId = result.insertId;

      if (resolvedTargetType === "specific" && Array.isArray(target_user_ids)) {
        for (const uid of target_user_ids) {
          const userIdNum = Number(uid);
          if (Number.isFinite(userIdNum)) {
            await queryDB("INSERT INTO notice_targets (notice_id, user_id) VALUES (?, ?)", [noticeId, userIdNum]);
          }
        }
      }

      res.status(201).json({ id: noticeId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/notices/:id", authenticateToken, requireAdmin, requireModule("notices"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM notices WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Notice not found" });

      const { title, content_html, lottie_json, lottie_url, target_type, target_user_ids } = req.body;
      if (!title || !String(title).trim()) return res.status(400).json({ error: "Title is required" });
      if (!content_html || !String(content_html).trim()) return res.status(400).json({ error: "Notice content is required" });
      const resolvedTargetType = target_type === "specific" ? "specific" : "all";
      let lottieJsonStr: string | null = null;
      if (lottie_json && String(lottie_json).trim()) {
        const parsed = parseJsonBody(lottie_json);
        if (!parsed) return res.status(400).json({ error: "The pasted Lottie animation isn't valid JSON." });
        lottieJsonStr = JSON.stringify(parsed);
      }
      const lottieUrlStr = lottie_url && String(lottie_url).trim() ? String(lottie_url).trim() : null;

      await queryDB(
        "UPDATE notices SET title = ?, content_html = ?, lottie_json = ?, lottie_url = ?, target_type = ? WHERE id = ?",
        [String(title).trim(), String(content_html), lottieJsonStr, lottieUrlStr, resolvedTargetType, id]
      );

      // Replace the target list wholesale rather than diffing — simplest correct
      // behaviour for a form that always submits the full intended audience.
      await queryDB("DELETE FROM notice_targets WHERE notice_id = ?", [id]);
      if (resolvedTargetType === "specific" && Array.isArray(target_user_ids)) {
        for (const uid of target_user_ids) {
          const userIdNum = Number(uid);
          if (Number.isFinite(userIdNum)) {
            await queryDB("INSERT INTO notice_targets (notice_id, user_id) VALUES (?, ?)", [id, userIdNum]);
          }
        }
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Publish/unpublish toggle — pulls a Notice's popup down (or brings it back)
  // without losing it or its dismissal history, unlike deleting it outright.
  app.put("/api/notices/:id/active", authenticateToken, requireAdmin, requireModule("notices"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM notices WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Notice not found" });
      await queryDB("UPDATE notices SET is_active = ? WHERE id = ?", [req.body.is_active ? 1 : 0, id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/notices/:id", authenticateToken, requireAdmin, requireModule("notices"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM notices WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Notice not found" });
      await queryDB("DELETE FROM notices WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Employee Directory (Admin Panel -> Employees) — plain hand-entered company
  // roster, gated behind the "employees" AdminModuleKey like every other tab
  // (a Superadmin always has it; an Admin/User only once the Superadmin grants
  // it via PUT /api/users/:id/module-permissions). Not linked to login
  // accounts (User rows) — most listed employees never get one.
  app.get("/api/employees", authenticateToken, requireAdmin, requireModule("employees"), async (req, res) => {
    try {
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
  app.post("/api/employees", authenticateToken, requireAdmin, requireModule("employees"), async (req: any, res) => {
    try {
      const { employee_id, name, designation, department, department_id, email, phone, is_active, create_login, login_email, login_username, login_password, login_project_ids, login_module_keys } = req.body;
      if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required" });

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
            await queryDB("INSERT INTO admin_module_permissions (user_id, module_key) VALUES (?, ?)", [newUserId, moduleKey]);
          }
        }
      }

      // Employee Info / Status / Contact tab fields — all optional, all
      // normalized the same way (trim to null, dates left as-is, booleans to
      // 0/1). See EMPLOYEE_EXT_FIELDS.
      const extColumns = EMPLOYEE_EXT_FIELDS;
      const extValues = extColumns.map((field) => normalizeEmployeeExtValue(field, req.body[field]));
      const dept = await resolveEmployeeDepartment(req.body);

      const columns = ["employee_id", "name", "designation", "department", "department_id", "email", "phone", "is_active", "user_id", ...extColumns];
      const placeholders = columns.map(() => "?").join(", ");
      const values = [
        employee_id && String(employee_id).trim() ? String(employee_id).trim() : null,
        String(name).trim(),
        designation && String(designation).trim() ? String(designation).trim() : null,
        dept.department_name,
        dept.department_id,
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
      res.status(201).json({ id: result.insertId, user_id: newUserId, project_ids: grantedProjectIds, module_keys: grantedModuleKeys });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/employees/:id", authenticateToken, requireAdmin, requireModule("employees"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM all_employees WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Employee not found" });

      const { employee_id, name, designation, department, department_id, email, phone, is_active } = req.body;
      if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required" });

      const extColumns = EMPLOYEE_EXT_FIELDS;
      const extValues = extColumns.map((field) => normalizeEmployeeExtValue(field, req.body[field]));
      const dept = await resolveEmployeeDepartment(req.body);
      const setClause = ["employee_id = ?", "name = ?", "designation = ?", "department = ?", "department_id = ?", "email = ?", "phone = ?", "is_active = ?", ...extColumns.map((c) => `${c} = ?`)].join(", ");

      await queryDB(
        `UPDATE all_employees SET ${setClause} WHERE id = ?`,
        [
          employee_id && String(employee_id).trim() ? String(employee_id).trim() : null,
          String(name).trim(),
          designation && String(designation).trim() ? String(designation).trim() : null,
          dept.department_name,
          dept.department_id,
          email && String(email).trim() ? String(email).trim() : null,
          phone && String(phone).trim() ? String(phone).trim() : null,
          is_active === false ? 0 : 1,
          ...extValues,
          id
        ]
      );
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
          await queryDB("INSERT INTO admin_module_permissions (user_id, module_key) VALUES (?, ?)", [newUserId, moduleKey]);
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

  // Active, targeted, not-yet-dismissed Notices for the CALLING user — polled by
  // the User Panel right after login to decide whether to pop the Notice modal up.
  // Oldest-first, so a User who has several queued sees them in the order they were
  // published rather than newest-first.
  app.get("/api/notices/active", authenticateToken, async (req: any, res) => {
    try {
      const notices = await queryDB("SELECT * FROM notices");
      const active = notices.filter((n: any) => !!Number(n.is_active));
      if (active.length === 0) return res.json([]);

      const dismissals = await queryDB("SELECT * FROM notice_dismissals WHERE user_id = ?", [req.user.id]);
      const dismissedIds = new Set(dismissals.map((d: any) => Number(d.notice_id)));

      const targets = await queryDB("SELECT * FROM notice_targets");

      const visible = active.filter((n: any) => {
        if (dismissedIds.has(Number(n.id))) return false;
        if (n.target_type === "all") return true;
        return targets.some((t: any) => Number(t.notice_id) === Number(n.id) && Number(t.user_id) === Number(req.user.id));
      });

      visible.sort((a: any, b: any) => (a.id > b.id ? 1 : -1));

      res.json(
        visible.map((n: any) => ({
          id: n.id,
          title: n.title,
          content_html: n.content_html,
          lottie_json: n.lottie_json || null,
          lottie_url: n.lottie_url || null,
          created_at: n.created_at
        }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Marks one Notice as seen/closed for the calling user — it stops appearing for
  // them (but keeps showing to anyone else it's targeted at who hasn't dismissed it).
  app.post("/api/notices/:id/dismiss", authenticateToken, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      await queryDB("INSERT INTO notice_dismissals (notice_id, user_id) VALUES (?, ?)", [id, req.user.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 3. MPR Numbers CRUD
  app.get("/api/mpr-numbers", authenticateToken, async (req, res) => {
    try {
      const mprs = await queryDB("SELECT * FROM mpr_numbers ORDER BY mpr_no ASC");
      res.json(mprs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/mpr-numbers", authenticateToken, requireAdmin, requireModule("mprs"), async (req: any, res) => {
    try {
      const { mpr_no } = req.body;
      if (!mpr_no) return res.status(400).json({ error: "MPR number is required" });

      const result = await queryDB("INSERT INTO mpr_numbers (mpr_no, created_by) VALUES (?, ?)", [
        mpr_no.trim(),
        req.user.id
      ]);
      res.json({ id: result.insertId, mpr_no: mpr_no.trim() });
    } catch (err: any) {
      if (err.code === "ER_DUP_ENTRY" || err.message?.includes("already exists")) {
        return res.status(400).json({ error: "MPR number already exists" });
      }
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/mpr-numbers/:id", authenticateToken, requireAdmin, requireModule("mprs"), async (req, res) => {
    try {
      const { id } = req.params;
      const { mpr_no } = req.body;
      if (!mpr_no) return res.status(400).json({ error: "MPR number is required" });

      await queryDB("UPDATE mpr_numbers SET mpr_no = ? WHERE id = ?", [mpr_no.trim(), id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/mpr-numbers/:id", authenticateToken, requireAdmin, requireModule("mprs"), async (req, res) => {
    try {
      const { id } = req.params;
      await queryDB("DELETE FROM mpr_numbers WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 3b. Budgets — created by the Admin, then an Excel sheet of line items is imported
  // into them. Importing auto-adds every MRF No to the Approved MPR list and every
  // Project Name to the Approved Project list, if they don't already exist.
  // Listing is open to any authenticated user (not admin-only): Users must browse the
  // Budgets the Admin has created & imported before they're allowed to start a new MPR
  // Entry — clicking a Budget is now the entry point into the Entry form.
  app.get("/api/budgets", authenticateToken, async (req, res) => {
    try {
      // Explicit columns (not SELECT *) so the potentially large file_data blob is
      // never sent down for the list view — only whether a file exists (has_file).
      const budgets = await queryDB(
        "SELECT id, budget_name, created_by, created_at, original_filename, delivery_date_from, delivery_date_to, rate_approved_at, rate_approved_by, is_published, published_at, (file_data IS NOT NULL) AS has_file FROM budgets ORDER BY created_at DESC"
      );
      const counts = await queryDB("SELECT budget_id, COUNT(*) as cnt FROM budget_items GROUP BY budget_id");
      const countMap: Record<number, number> = {};
      for (const c of counts) countMap[c.budget_id] = Number(c.cnt);
      // Which of these Budgets has THIS user already submitted (and is therefore
      // locked from further entries)? Scoped to req.user.id, not global.
      const submittedRows = await queryDB("SELECT budget_id FROM budget_submissions WHERE user_id = ?", [
        (req as any).user.id
      ]);
      const submittedSet = new Set(submittedRows.map((r: any) => Number(r.budget_id)));
      const isAdmin = (req as any).user.role === "admin" || (req as any).user.role === "superadmin";
      const mapped = budgets.map((b: any) => ({
        ...b,
        has_file: !!Number(b.has_file),
        delivery_date_from: toDateOnlyString(b.delivery_date_from),
        delivery_date_to: toDateOnlyString(b.delivery_date_to),
        item_count: countMap[b.id] || 0,
        is_published: !!Number(b.is_published),
        submitted: submittedSet.has(Number(b.id))
      }));
      // Non-admin Users only ever see Budgets the Admin has explicitly Submitted
      // (is_published) from the Import Rate File / Import Budget from Excel page —
      // a Budget that's still being imported/reviewed stays invisible to them.
      // Admins always see every Budget, published or not, so they can manage it.
      res.json(isAdmin ? mapped : mapped.filter((b: any) => b.is_published));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download/view the original Excel file that was imported into this Budget.
  app.get("/api/budgets/:id/file", authenticateToken, requireAdmin, requireModule("imports"), async (req, res) => {
    try {
      const budgetId = Number(req.params.id);
      const rows = await queryDB(
        "SELECT id, original_filename, file_mimetype, file_data FROM budgets WHERE id = ?",
        [budgetId]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Budget not found" });
      const b = rows[0];
      if (!b.file_data) return res.status(404).json({ error: "No Excel file has been saved for this budget yet" });

      const buffer: Buffer = Buffer.isBuffer(b.file_data) ? b.file_data : Buffer.from(b.file_data);
      res.setHeader("Content-Type", b.file_mimetype || "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(b.original_filename || `budget_${budgetId}.xlsx`)}"`
      );
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/budgets", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const { budget_name } = req.body;
      if (!budget_name || !String(budget_name).trim()) {
        return res.status(400).json({ error: "Budget Name is required" });
      }
      const result = await queryDB("INSERT INTO budgets (budget_name, created_by) VALUES (?, ?)", [
        String(budget_name).trim(),
        req.user.id
      ]);
      res.json({ id: result.insertId, budget_name: String(budget_name).trim() });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to create budget" });
    }
  });

  // "Submit" a Budget (Admin-only): flips is_published on, which is what makes it
  // show up in GET /api/budgets for ordinary Users — until this is called, the Budget
  // only exists on the Admin's Data Import page. Body { published: false } lets the
  // Admin pull a Budget back to Draft (e.g. it was submitted by mistake, or needs more
  // rows imported first) without deleting anything already saved on it.
  app.post("/api/budgets/:id/publish", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const budgetId = Number(req.params.id);
      const budgetRows = await queryDB("SELECT id FROM budgets WHERE id = ?", [budgetId]);
      if (budgetRows.length === 0) return res.status(404).json({ error: "Budget not found" });

      const publish = req.body?.published !== false; // default: publish
      await queryDB("UPDATE budgets SET is_published = ?, published_at = ? WHERE id = ?", [
        publish ? 1 : 0,
        publish ? new Date() : null,
        budgetId
      ]);
      res.json({ success: true, is_published: publish });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to update Budget submission status" });
    }
  });

  // Open to any authenticated user (not admin-only): once a User picks a Budget from
  // the list, the Entry Form calls this to know exactly which Project(s) and MPR/MRF
  // Nos were imported into that Budget, so only those can be picked for a new entry.
  app.get("/api/budgets/:id/items", authenticateToken, async (req: any, res) => {
    try {
      // requisitioned_by_me: how much of THIS item's Qty the CALLING user has already
      // put into their own active entries — lets the User Entry Form show/cap the
      // remaining Requisitioned Qty available to them for each item (req_qty is the
      // item's total from the imported Excel, shared across the sheet; consumption is
      // tracked per user, per the app's Requisitioned Qty splitting feature).
      const items = await queryDB(
        `SELECT bi.*,
           (SELECT COALESCE(SUM(e.requisitioned_qty), 0) FROM entries e
              WHERE e.budget_item_id = bi.id AND e.created_by = ? AND e.deleted_at IS NULL) AS requisitioned_by_me
         FROM budget_items bi WHERE bi.budget_id = ? ORDER BY bi.id ASC`,
        [req.user.id, req.params.id]
      );
      res.json(items);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Look up the imported "Description of Materials" for a given MRF/MPR No, so the User
  // Entry Form can auto-fill Item Name the moment an MPR No is selected. Open to any
  // authenticated user (not admin-only) since this is used from the User Entry Form.
  // If the same MRF No was imported more than once, the most recently imported row wins.
  app.get("/api/budget-items/lookup", authenticateToken, async (req, res) => {
    try {
      const mprNo = String(req.query.mpr_no || "").trim();
      if (!mprNo) return res.json({ description: null });
      const rows = await queryDB(
        "SELECT description FROM budget_items WHERE LOWER(mrf_no) = LOWER(?) ORDER BY id DESC LIMIT 1",
        [mprNo]
      );
      res.json({ description: rows.length > 0 ? rows[0].description : null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // "Submit Budget" — a User marks a Budget as finished once they've entered every Job
  // they intend to under it. Recorded per (budget_id, user_id): after this, POST
  // /api/entries rejects any further entries from THIS user under THIS budget. It does
  // not affect other users still working on the same Budget, and it's irreversible from
  // the User side (only an Admin deleting the Budget clears it).
  app.post("/api/budgets/:id/submit", authenticateToken, requireBudgetModuleAccess, async (req: any, res) => {
    try {
      const budgetId = Number(req.params.id);
      const budgets = await queryDB("SELECT id FROM budgets WHERE id = ?", [budgetId]);
      if (budgets.length === 0) return res.status(404).json({ error: "Budget not found" });

      const already = await queryDB("SELECT * FROM budget_submissions WHERE budget_id = ? AND user_id = ?", [
        budgetId,
        req.user.id
      ]);
      if (already.length > 0) {
        return res.json({ success: true, already_submitted: true });
      }

      // Block submitting an empty Budget as "finished" — this user must have created
      // at least one entry under this Budget first. Enforced here too (not just a
      // disabled button in the UI) so it can't be bypassed via a direct API call.
      const ownEntryRows = await queryDB("SELECT id FROM entries WHERE budget_id = ? AND created_by = ? LIMIT 1", [
        budgetId,
        req.user.id
      ]);
      if (ownEntryRows.length === 0) {
        return res.status(400).json({
          error: "You haven't added any entries to this Budget yet. Add at least one MPR entry before submitting."
        });
      }

      await queryDB("INSERT INTO budget_submissions (budget_id, user_id) VALUES (?, ?)", [budgetId, req.user.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to submit budget" });
    }
  });

  // "Approve & Calculate" — Admin action per Budget. Matches every one of this Budget's
  // MPR entries against the Rate File (Item Name + Specification -> Rate, Item Name ->
  // Materials Category), computes Amount = Rate x Req. Qty, and writes the result onto
  // each entry. Re-runnable any time (e.g. after the Admin updates the Rate File to fill
  // in previously-missing items) — it always recomputes from scratch using whatever is
  // currently in rate_list / material_categories, it never merges with old values.
  app.post("/api/budgets/:id/approve", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const budgetId = Number(req.params.id);
      const budgetRows = await queryDB("SELECT id FROM budgets WHERE id = ?", [budgetId]);
      if (budgetRows.length === 0) return res.status(404).json({ error: "Budget not found" });

      // Blank-ish placeholder text ("NONE", "N/A", "-", etc. — common in these Excel
      // sheets where a real Excel-blank wasn't used) normalizes to the SAME empty
      // string as an actual blank cell, so "Specification: NONE" matches a Rate row
      // whose Specification cell is genuinely empty.
      const BLANK_SPEC_WORDS = new Set(["none", "n/a", "na", "n.a", "n.a.", "nil", "-", "--", "nill"]);
      const norm = (v: any) => {
        if (v === null || v === undefined) return "";
        const s = String(v).trim().toLowerCase().replace(/\s+/g, " ");
        return BLANK_SPEC_WORDS.has(s) ? "" : s;
      };

      let entryRows: any[];
      let rateRows: any[];
      let categoryRows: any[];

      if (isMySQLConnected && dbPool) {
        // Resolve each entry back to its source Budget Excel row the same way GET
        // /api/entries does: prefer budget_item_id, fall back to an MRF No +
        // Description text match for entries created before that column existed.
        const [rows]: any = await dbPool.execute(
          `
          SELECT e.id, e.item_name,
            bi.description AS bi_description, bi.specification AS bi_specification, bi.req_qty AS bi_req_qty
          FROM entries e
          JOIN mpr_numbers m ON e.mpr_id = m.id
          LEFT JOIN budget_items bi ON bi.id = COALESCE(
            e.budget_item_id,
            (
              SELECT bi2.id FROM budget_items bi2
              WHERE bi2.budget_id = e.budget_id AND LOWER(TRIM(bi2.mrf_no)) = LOWER(TRIM(m.mpr_no))
                AND LOWER(TRIM(bi2.description)) = LOWER(TRIM(e.item_name))
              ORDER BY bi2.id ASC LIMIT 1
            )
          )
          WHERE e.budget_id = ? AND e.deleted_at IS NULL
          `,
          [budgetId]
        );
        entryRows = rows;
        const [r]: any = await dbPool.execute("SELECT materials_name, unit, rate, specification FROM rate_list");
        rateRows = r;
        const [c]: any = await dbPool.execute("SELECT head, sub1, sub2, sub3, details, sector FROM material_categories");
        categoryRows = c;
      } else {
        const budgetItemsById = new Map(memoryDb.budget_items.map((bi: any) => [bi.id, bi]));
        entryRows = memoryDb.entries
          .filter((e: any) => e.budget_id === budgetId && !e.deleted_at)
          .map((e: any) => {
            const bi = e.budget_item_id ? budgetItemsById.get(e.budget_item_id) : null;
            return { id: e.id, item_name: e.item_name, bi_description: bi?.description, bi_specification: bi?.specification, bi_req_qty: bi?.req_qty };
          });
        rateRows = memoryDb.rate_list;
        categoryRows = memoryDb.material_categories;
      }

      if (entryRows.length === 0) {
        return res.status(400).json({ error: "This Budget has no MPR entries to calculate yet." });
      }

      // Keyed by normalized Item Name -> every {specification, rate} row for that name,
      // so an unambiguous single match can be told apart from one that genuinely needs
      // an exact Specification match (see the loop below).
      const rateByName = new Map<string, { specification: string; rate: number }[]>();
      for (const r of rateRows) {
        const key = norm(r.materials_name);
        if (!key) continue;
        const list = rateByName.get(key) || [];
        list.push({ specification: norm(r.specification), rate: Number(r.rate) });
        rateByName.set(key, list);
      }

      const categoryByDetails = new Map<string, { head: string; sub1: string; sub2: string; sub3: string; sector: string }>();
      for (const c of categoryRows) {
        const key = norm(c.details);
        if (!key || categoryByDetails.has(key)) continue; // first row wins on duplicate Details
        categoryByDetails.set(key, { head: c.head, sub1: c.sub1, sub2: c.sub2, sub3: c.sub3, sector: c.sector });
      }

      const missingRateItems = new Map<string, { item_name: string; specification: string }>();
      const missingCategoryItems = new Map<string, string>();
      let matchedCount = 0;
      const updates: { id: number; matchedRate: number | null; amount: number | null; category: any }[] = [];

      for (const row of entryRows) {
        const itemName = row.bi_description || row.item_name;
        const spec = row.bi_specification;
        const reqQty =
          row.bi_req_qty !== null && row.bi_req_qty !== undefined && String(row.bi_req_qty).trim() !== ""
            ? Number(row.bi_req_qty)
            : null;

        const nameKey = norm(itemName);
        const specKey = norm(spec);
        const candidates = rateByName.get(nameKey) || [];
        // Exact Item Name + Specification match only. If the Specification doesn't
        // match any row for this Item Name — even if other rows share the same
        // Item Name with a DIFFERENT Specification/Rate — this is treated as "not
        // found" and goes to the Missing Rate list, never guessed from an unrelated
        // Specification's rate (several items in the real Rate File have wildly
        // different rates per Specification for the same Item Name).
        //
        // If MORE THAN ONE Rate row shares this exact Item Name + Specification (a
        // duplicate/undifferentiated entry in the Rate sheet itself, e.g. two "Local
        // Sand" rows both with a blank Specification but different Rates), that's
        // just as unresolvable as no match at all — silently picking the first one
        // would be an arbitrary guess, so this also goes to Missing Rate for the
        // Admin to de-duplicate in the Rate File.
        const matchingSpecRows = candidates.filter((c) => c.specification === specKey);
        const matchedRate = matchingSpecRows.length === 1 ? matchingSpecRows[0].rate : null;
        const category = categoryByDetails.get(nameKey) || null;
        const amount = matchedRate !== null && reqQty !== null && Number.isFinite(reqQty) ? matchedRate * reqQty : null;

        if (matchedRate === null) {
          const dedupeKey = `${nameKey}|||${specKey}`;
          if (!missingRateItems.has(dedupeKey)) {
            missingRateItems.set(dedupeKey, { item_name: itemName || "(blank)", specification: spec || "" });
          }
        } else {
          matchedCount++;
        }
        if (!category && !missingCategoryItems.has(nameKey)) {
          missingCategoryItems.set(nameKey, itemName || "(blank)");
        }

        updates.push({ id: row.id, matchedRate, amount, category });
      }

      if (isMySQLConnected && dbPool) {
        for (const u of updates) {
          await dbPool.execute(
            `UPDATE entries SET matched_rate = ?, computed_amount = ?, category_head = ?, category_sub1 = ?, category_sub2 = ?, category_sub3 = ?, category_sector = ?, rate_calculated_at = NOW() WHERE id = ?`,
            [
              u.matchedRate,
              u.amount,
              u.category?.head || null,
              u.category?.sub1 || null,
              u.category?.sub2 || null,
              u.category?.sub3 || null,
              u.category?.sector || null,
              u.id
            ]
          );
        }
        await dbPool.execute(`UPDATE budgets SET rate_approved_at = NOW(), rate_approved_by = ? WHERE id = ?`, [
          req.user.id,
          budgetId
        ]);
      } else {
        const updateById = new Map(updates.map((u) => [u.id, u]));
        memoryDb.entries = memoryDb.entries.map((e: any) => {
          const u = updateById.get(e.id);
          if (!u) return e;
          return {
            ...e,
            matched_rate: u.matchedRate,
            computed_amount: u.amount,
            category_head: u.category?.head || null,
            category_sub1: u.category?.sub1 || null,
            category_sub2: u.category?.sub2 || null,
            category_sub3: u.category?.sub3 || null,
            category_sector: u.category?.sector || null,
            rate_calculated_at: new Date()
          };
        });
        const b = memoryDb.budgets.find((x: any) => x.id === budgetId);
        if (b) {
          b.rate_approved_at = new Date();
          b.rate_approved_by = req.user.id;
        }
      }

      res.json({
        success: true,
        total_entries: entryRows.length,
        matched_rate_count: matchedCount,
        missing_rate: Array.from(missingRateItems.values()),
        missing_category: Array.from(missingCategoryItems.values())
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to approve & calculate this Budget" });
    }
  });

  // Deleting a Budget wipes out EVERYTHING created under it — not just the imported
  // Budget Excel rows (budget_items) but every MPR Entry and Job a User submitted
  // against it too. Without this, those entries/jobs used to survive with budget_id
  // set to NULL (orphaned but still visible in Job Entry Details / Admin reports) —
  // deleting the Budget is meant to be a full, permanent wipe of that relation.
  //
  // The Approved MPR Numbers List (mpr_numbers) is NOT simply wiped alongside it,
  // though — that table has no budget_id column at all: mpr_no is GLOBALLY unique,
  // and the same MRF No can legitimately be imported into more than one Budget's
  // Excel (re-used across periods). So after the cascade above, we only remove the
  // MPR Numbers that came in from THIS Budget's import AND are not referenced by any
  // other Budget's imported rows or any other entry left in the system — an MRF No
  // still in use elsewhere is left alone.
  app.delete("/api/budgets/:id", authenticateToken, requireAdmin, requireModule("imports"), async (req, res) => {
    try {
      const budgetId = req.params.id;
      const budgets = await queryDB("SELECT id FROM budgets WHERE id = ?", [budgetId]);
      if (budgets.length === 0) return res.status(404).json({ error: "Budget not found" });

      // Snapshot which MPR Numbers this Budget's imported Excel rows touch, BEFORE
      // those budget_items rows are deleted below — this is the candidate list to
      // clean up afterwards (only the ones that turn out to be orphaned).
      const mrfRows = await queryDB(
        "SELECT mrf_no FROM budget_items WHERE budget_id = ? AND mrf_no IS NOT NULL AND mrf_no <> ''",
        [budgetId]
      );
      const candidateMrfNos = Array.from(
        new Set(mrfRows.map((r: any) => String(r.mrf_no).trim().toLowerCase()).filter(Boolean))
      );

      // Order matters: entries reference jobs/budget_items/budgets, so entries go
      // first, then jobs, then the imported Excel rows, then the submission locks,
      // and finally the Budget itself.
      await queryDB("DELETE FROM entries WHERE budget_id = ?", [budgetId]);
      await queryDB("DELETE FROM jobs WHERE budget_id = ?", [budgetId]);
      await queryDB("DELETE FROM budget_items WHERE budget_id = ?", [budgetId]);
      await queryDB("DELETE FROM budget_submissions WHERE budget_id = ?", [budgetId]);
      await queryDB("DELETE FROM budgets WHERE id = ?", [budgetId]);

      // Now that this Budget's own rows are gone, remove each candidate MPR No from
      // the Approved list ONLY if nothing else in the system still points to it —
      // another Budget's budget_items, or an entry (active or still sitting in the
      // Job Recycle bin) under a different Budget.
      for (const mrfNo of candidateMrfNos) {
        const stillInBudgetItems = await queryDB(
          "SELECT COUNT(*) as cnt FROM budget_items WHERE LOWER(mrf_no) = LOWER(?)",
          [mrfNo]
        );
        if ((stillInBudgetItems[0]?.cnt || 0) > 0) continue;

        const mprRows = await queryDB("SELECT id FROM mpr_numbers WHERE LOWER(mpr_no) = LOWER(?)", [mrfNo]);
        if (mprRows.length === 0) continue;
        const mprId = mprRows[0].id;

        const stillInEntries = await queryDB("SELECT COUNT(*) as cnt FROM entries WHERE mpr_id = ?", [mprId]);
        if ((stillInEntries[0]?.cnt || 0) > 0) continue;

        await queryDB("DELETE FROM mpr_numbers WHERE id = ?", [mprId]);
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Import the Rate File — a reference/lookup Excel with two sheets: "Rate" (materials
  // price list) and "Materials Category" (Head/Sub-1/Sub-2/Sub-3 classification tree).
  // The client parses both sheets and posts the already-mapped rows here. Each
  // import fully REPLACES the previous data (delete-then-insert) rather than merging,
  // since this is always re-uploaded as a complete sheet, not edited row-by-row.
  app.post("/api/rate-file/import", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const { rate_rows, category_rows, file_base64, file_name, file_mimetype } = req.body;
      if ((!Array.isArray(rate_rows) || rate_rows.length === 0) && (!Array.isArray(category_rows) || category_rows.length === 0)) {
        return res.status(400).json({ error: "No rows found in either sheet of the uploaded Excel file." });
      }

      const field = (v: any) => (v !== undefined && v !== null && String(v).trim() !== "" ? String(v).trim() : null);
      const numOrNull = (v: any) => {
        if (v === undefined || v === null || String(v).trim() === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };

      const rateRecords = (rate_rows || [])
        .map((r: any) => ({
          materials_name: field(r.materials_name),
          unit: field(r.unit),
          rate: numOrNull(r.rate),
          specification: field(r.specification),
          assigned_person: field(r.assigned_person),
          remarks: field(r.remarks)
        }))
        .filter((r: any) => r.materials_name); // Materials Name is the only required field in this sheet

      const categoryRecords = (category_rows || [])
        .map((r: any) => ({
          sl_no: numOrNull(r.sl_no),
          head: field(r.head),
          sub1: field(r.sub1),
          sub2: field(r.sub2),
          sub3: field(r.sub3),
          details: field(r.details),
          sector: field(r.sector)
        }))
        .filter((r: any) => r.head || r.sub1 || r.sub2 || r.sub3 || r.details); // skip fully blank rows

      if (isMySQLConnected && dbPool) {
        // Only replace rows that came from a previous Excel import — a manually
        // entered rate (is_manual = 1, added via "No rate match" -> manual entry)
        // survives this re-import instead of being wiped out.
        await dbPool.execute("DELETE FROM rate_list WHERE is_manual = 0");
        await bulkInsert(
          "rate_list",
          ["materials_name", "unit", "rate", "specification", "assigned_person", "remarks"],
          rateRecords.map((r: any) => [r.materials_name, r.unit, r.rate, r.specification, r.assigned_person, r.remarks])
        );

        await dbPool.execute("DELETE FROM material_categories");
        await bulkInsert(
          "material_categories",
          ["sl_no", "head", "sub1", "sub2", "sub3", "details", "sector"],
          categoryRecords.map((r: any) => [r.sl_no, r.head, r.sub1, r.sub2, r.sub3, r.details, r.sector])
        );

        if (file_base64 && typeof file_base64 === "string") {
          try {
            const fileBuffer = Buffer.from(file_base64, "base64");
            await dbPool.execute(
              `INSERT INTO rate_file_meta (id, original_filename, file_mimetype, file_data, imported_at)
               VALUES (1, ?, ?, ?, NOW())
               ON DUPLICATE KEY UPDATE original_filename = VALUES(original_filename),
                 file_mimetype = VALUES(file_mimetype), file_data = VALUES(file_data), imported_at = NOW()`,
              [
                String(file_name || "Rate_File.xlsx").slice(0, 255),
                String(file_mimetype || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
                fileBuffer
              ]
            );
          } catch (fileErr: any) {
            console.warn("Failed to save original Rate File: " + fileErr.message);
          }
        }
      } else {
        const manualRows = memoryDb.rate_list.filter((r: any) => r.is_manual);
        memoryDb.rate_list = [...manualRows, ...rateRecords.map((r: any, i: number) => ({ id: manualRows.length + i + 1, is_manual: false, ...r }))];
        memoryDb.material_categories = categoryRecords.map((r: any, i: number) => ({ id: i + 1, ...r }));
        if (file_base64) {
          memoryDb.rate_file_meta = {
            original_filename: file_name || "Rate_File.xlsx",
            file_mimetype: file_mimetype || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            imported_at: new Date()
          };
        }
      }

      res.json({
        success: true,
        rate_inserted: rateRecords.length,
        category_inserted: categoryRecords.length
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to import the Rate file" });
    }
  });

  // Current Rate File status — row counts + last-imported filename/date — so the Admin
  // Panel can show what's already saved without re-importing.
  app.get("/api/rate-file/summary", authenticateToken, requireAdmin, requireModule("imports"), async (req, res) => {
    try {
      if (isMySQLConnected && dbPool) {
        const [rateCountRows]: any = await dbPool.execute("SELECT COUNT(*) as cnt FROM rate_list");
        const [catCountRows]: any = await dbPool.execute("SELECT COUNT(*) as cnt FROM material_categories");
        const [metaRows]: any = await dbPool.execute(
          "SELECT original_filename, imported_at FROM rate_file_meta WHERE id = 1"
        );
        res.json({
          rate_count: rateCountRows[0]?.cnt || 0,
          category_count: catCountRows[0]?.cnt || 0,
          original_filename: metaRows[0]?.original_filename || null,
          imported_at: metaRows[0]?.imported_at || null
        });
      } else {
        res.json({
          rate_count: memoryDb.rate_list.length,
          category_count: memoryDb.material_categories.length,
          original_filename: memoryDb.rate_file_meta?.original_filename || null,
          imported_at: memoryDb.rate_file_meta?.imported_at || null
        });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to load Rate File summary" });
    }
  });

  // Full Rate list (materials price list) — for the Admin "View" modal.
  app.get("/api/rate-file/rate-list", authenticateToken, requireAdmin, requireModule("imports"), async (req, res) => {
    try {
      if (isMySQLConnected && dbPool) {
        const rows = await queryDB("SELECT * FROM rate_list ORDER BY id ASC");
        res.json(rows);
      } else {
        res.json(memoryDb.rate_list);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to load the Rate list" });
    }
  });

  // Manually add/update a Rate — used from the "Approve & Calculate" -> Missing Rate
  // review list, so the Admin can fix a "No rate match" right there in the app instead
  // of always having to go edit the Excel and re-import. Upserts on exact Item Name +
  // Specification (case/whitespace-insensitive) so re-saving the same item just updates
  // its rate rather than piling up duplicate rows. Marked is_manual so a future Rate
  // File re-import never wipes it out.
  app.post("/api/rate-list/manual", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const materials_name = String(req.body.materials_name || "").trim();
      const specification = req.body.specification !== undefined && req.body.specification !== null
        ? String(req.body.specification).trim()
        : "";
      const rate = Number(req.body.rate);

      if (!materials_name) return res.status(400).json({ error: "Item Name is required." });
      if (!Number.isFinite(rate) || rate < 0) return res.status(400).json({ error: "A valid, non-negative Rate is required." });

      const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
      const nameKey = norm(materials_name);
      const specKey = norm(specification);

      if (isMySQLConnected && dbPool) {
        const [existingRows]: any = await dbPool.execute(
          "SELECT id FROM rate_list WHERE LOWER(TRIM(materials_name)) = ? AND LOWER(TRIM(COALESCE(specification, ''))) = ? AND is_manual = 1",
          [nameKey, specKey]
        );
        if (existingRows.length > 0) {
          await dbPool.execute("UPDATE rate_list SET rate = ?, added_by = ? WHERE id = ?", [
            rate,
            req.user.id,
            existingRows[0].id
          ]);
        } else {
          await dbPool.execute(
            "INSERT INTO rate_list (materials_name, unit, rate, specification, assigned_person, remarks, is_manual, added_by) VALUES (?, NULL, ?, ?, NULL, 'Manually entered by Admin', 1, ?)",
            [materials_name, rate, specification || null, req.user.id]
          );
        }
      } else {
        const existing = memoryDb.rate_list.find(
          (r: any) => r.is_manual && norm(String(r.materials_name || "")) === nameKey && norm(String(r.specification || "")) === specKey
        );
        if (existing) {
          existing.rate = rate;
          existing.added_by = req.user.id;
        } else {
          memoryDb.rate_list.push({
            id: (memoryDb.rate_list.reduce((max: number, r: any) => Math.max(max, r.id || 0), 0)) + 1,
            materials_name,
            unit: null,
            rate,
            specification: specification || null,
            assigned_person: null,
            remarks: "Manually entered by Admin",
            is_manual: true,
            added_by: req.user.id
          });
        }
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to save the manual rate" });
    }
  });

  // Full Materials Category tree — for the Admin "View" modal.
  app.get("/api/rate-file/categories", authenticateToken, requireAdmin, requireModule("imports"), async (req, res) => {
    try {
      if (isMySQLConnected && dbPool) {
        const rows = await queryDB("SELECT * FROM material_categories ORDER BY id ASC");
        res.json(rows);
      } else {
        res.json(memoryDb.material_categories);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to load Materials Categories" });
    }
  });

  // Import parsed Excel rows into a Budget.
  // Expected Excel header: Sl.No. | Project Name | Req. No. | MRF No | Date |
  // Description of Materials | Unit | Specification | Req. Qty | Purchase Order Qty |
  // Received Qty | Balance Qty | Entry User | Aproved Date | App. User | Site Sup. Date
  // (the client parses the .xlsx and posts already-mapped row objects here)
  app.post("/api/budgets/:id/import", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const budgetId = Number(req.params.id);
      const budgetRows = await queryDB("SELECT id FROM budgets WHERE id = ?", [budgetId]);
      if (budgetRows.length === 0) return res.status(404).json({ error: "Budget not found" });

      const { rows, file_base64, file_name, file_mimetype } = req.body;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: "No rows found in the uploaded Excel file" });
      }

      // Save the original Excel file itself against this Budget (overwrites any
      // previously saved file, so it always reflects the most recently imported sheet).
      if (file_base64 && typeof file_base64 === "string") {
        try {
          const fileBuffer = Buffer.from(file_base64, "base64");
          await queryDB(
            "UPDATE budgets SET original_filename = ?, file_mimetype = ?, file_data = ? WHERE id = ?",
            [
              String(file_name || `budget_${budgetId}.xlsx`).slice(0, 255),
              String(file_mimetype || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
              fileBuffer,
              budgetId
            ]
          );
        } catch (fileErr: any) {
          console.warn("Failed to save original Excel file for budget " + budgetId + ": " + fileErr.message);
        }
      }

      let itemsInserted = 0;
      let mprAdded = 0;
      let mprAlreadyExisting = 0;
      let projectsAdded = 0;
      let projectsAlreadyExisting = 0;

      for (const r of rows) {
        const field = (v: any) => (v != null ? String(v).trim() : "");
        const sl_no = field(r.sl_no);
        const project_name = field(r.project_name);
        const req_no = field(r.req_no);
        const mrf_no = field(r.mrf_no);
        const item_date = field(r.item_date);
        const description = field(r.description);
        const unit = field(r.unit);
        const specification = field(r.specification);
        const req_qty = field(r.req_qty);
        const po_qty = field(r.po_qty);
        const received_qty = field(r.received_qty);
        const balance_qty = field(r.balance_qty);
        const entry_user = field(r.entry_user);
        const approved_date = field(r.approved_date);
        const app_user = field(r.app_user);
        const site_sup_date = field(r.site_sup_date);

        // Skip fully blank rows
        if (!project_name && !req_no && !mrf_no && !description) continue;

        await queryDB(
          `INSERT INTO budget_items
           (budget_id, sl_no, project_name, req_no, mrf_no, item_date, description, unit, specification,
            req_qty, po_qty, received_qty, balance_qty, entry_user, approved_date, app_user, site_sup_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            budgetId, sl_no, project_name, req_no, mrf_no, item_date, description, unit, specification,
            req_qty, po_qty, received_qty, balance_qty, entry_user, approved_date, app_user, site_sup_date
          ]
        );
        itemsInserted++;

        if (project_name) {
          const pr = await findOrCreateProject(project_name, req.user.id);
          if (pr.created) projectsAdded++;
          else if (pr.id) projectsAlreadyExisting++;
        }
        if (mrf_no) {
          const mr = await findOrCreateMpr(mrf_no, req.user.id);
          if (mr.created) mprAdded++;
          else if (mr.id) mprAlreadyExisting++;
        }
      }

      res.json({
        success: true,
        items_inserted: itemsInserted,
        mpr_added: mprAdded,
        mpr_already_existing: mprAlreadyExisting,
        projects_added: projectsAdded,
        projects_already_existing: projectsAlreadyExisting
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to import Excel data" });
    }
  });

  // Admin sets (or clears) the allowed Delivery Date window for a Budget, after it's
  // been imported. Once set, every MPR Entry created/edited under this Budget must
  // have a Delivery Date inside [delivery_date_from, delivery_date_to] (both inclusive)
  // — enforced here on write, and in POST/PUT /api/entries so it can't be bypassed via
  // a direct API call. Passing both as null/empty clears the restriction.
  app.put("/api/budgets/:id/delivery-range", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const budgetId = Number(req.params.id);
      const budgetRows = await queryDB("SELECT id FROM budgets WHERE id = ?", [budgetId]);
      if (budgetRows.length === 0) return res.status(404).json({ error: "Budget not found" });

      let { delivery_date_from, delivery_date_to } = req.body;
      delivery_date_from = delivery_date_from ? String(delivery_date_from).trim() : null;
      delivery_date_to = delivery_date_to ? String(delivery_date_to).trim() : null;

      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      if (delivery_date_from && !dateRe.test(delivery_date_from)) {
        return res.status(400).json({ error: "Invalid Delivery Date From." });
      }
      if (delivery_date_to && !dateRe.test(delivery_date_to)) {
        return res.status(400).json({ error: "Invalid Delivery Date To." });
      }
      if (delivery_date_from && delivery_date_to && delivery_date_from > delivery_date_to) {
        return res.status(400).json({ error: "Delivery Date From must be on or before Delivery Date To." });
      }

      await queryDB("UPDATE budgets SET delivery_date_from = ?, delivery_date_to = ? WHERE id = ?", [
        delivery_date_from,
        delivery_date_to,
        budgetId
      ]);

      res.json({ success: true, delivery_date_from, delivery_date_to });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to set Delivery Date range" });
    }
  });

  // 4. Jobs & Duration
  app.get("/api/jobs", authenticateToken, async (req, res) => {
    try {
      const jobs = await queryDB("SELECT * FROM jobs ORDER BY job_no ASC");
      res.json(jobs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/jobs/check/:jobNo", authenticateToken, async (req, res) => {
    try {
      const { jobNo } = req.params;
      const jobs = await queryDB("SELECT * FROM jobs WHERE job_no = ?", [jobNo.trim()]);
      if (jobs.length > 0) {
        res.json({ exists: true, job: jobs[0] });
      } else {
        res.json({ exists: false });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 5. Entries
  //
  // Regular Users only ever see THEIR OWN entries here (Recent Entries must not leak
  // another user's job/entry data) — an Admin still sees everything, since Reports /
  // Job Recycle need the full picture. MPR-No uniqueness is still enforced system-wide
  // server-side regardless of what any one user can see; GET /api/entries/mpr-usage
  // below is the (deliberately minimal) endpoint that lets a User discover "this MPR
  // No is already used, under Job X" without exposing whose entry it is.
  app.get("/api/entries", authenticateToken, async (req: any, res) => {
    try {
      // Every column of the exact Budget Excel row this entry's Item Name was picked
      // from (matched on budget_id + MRF No + Description, via a correlated subquery
      // that resolves to a single budget_items.id so the join can never duplicate a
      // row) is attached here, so both the User's "view" popup and the Admin's full
      // Excel export can show/download Specification, Qty and the rest without a
      // separate round trip.
      let sql = `
        SELECT e.*, p.project_name, j.job_no, j.job_duration, m.mpr_no, u.name as user_name, b.budget_name,
          -- Admin-set Delivery Date window for this entry's Budget, straight from the
          -- budgets row (NOT from GET /api/budgets, which hides an unpublished Budget
          -- from a non-admin caller) — so Job Edit's date picker can always enforce it,
          -- even for a Budget the owner can no longer see in their Budgets list.
          b.delivery_date_from AS delivery_date_from, b.delivery_date_to AS delivery_date_to,
          bi.sl_no AS bi_sl_no, bi.req_no AS bi_req_no, bi.item_date AS bi_item_date,
          bi.specification, bi.req_qty, bi.unit, bi.po_qty, bi.received_qty, bi.balance_qty,
          bi.entry_user AS bi_entry_user, bi.approved_date AS bi_approved_date,
          bi.app_user AS bi_app_user, bi.site_sup_date,
          -- Whether the creating user has already submitted (locked) the Budget this
          -- entry belongs to — the client uses this to decide if editing is allowed.
          (SELECT COUNT(*) FROM budget_submissions bs
             WHERE bs.budget_id = e.budget_id AND bs.user_id = e.created_by) AS budget_locked
        FROM entries e
        JOIN projects p ON e.project_id = p.id
        JOIN jobs j ON e.job_id = j.id
        JOIN mpr_numbers m ON e.mpr_id = m.id
        LEFT JOIN users u ON e.created_by = u.id
        LEFT JOIN budgets b ON e.budget_id = b.id
        -- Prefer the exact source row via budget_item_id (pins to the specific Excel
        -- row, so entries with a duplicate Description still each show their OWN
        -- Specification/Qty). Only falls back to the old description-text match for
        -- entries created before that column existed (budget_item_id IS NULL).
        LEFT JOIN budget_items bi ON bi.id = COALESCE(
          e.budget_item_id,
          (
            SELECT bi2.id FROM budget_items bi2
            WHERE bi2.budget_id = e.budget_id AND LOWER(TRIM(bi2.mrf_no)) = LOWER(TRIM(m.mpr_no))
              AND LOWER(TRIM(bi2.description)) = LOWER(TRIM(e.item_name))
            ORDER BY bi2.id ASC LIMIT 1
          )
        )
        WHERE e.deleted_at IS NULL
      `;
      const params: any[] = [];
      if (req.user.role !== "admin" && req.user.role !== "superadmin") {
        sql += ` AND e.created_by = ?`;
        params.push(req.user.id);
      }
      sql += ` ORDER BY e.entry_date DESC, e.id DESC`;
      const entries = await queryDB(sql, params);
      res.json(
        entries.map((e: any) => ({
          ...e,
          budget_locked: !!Number(e.budget_locked),
          delivery_date_from: toDateOnlyString(e.delivery_date_from),
          delivery_date_to: toDateOnlyString(e.delivery_date_to)
        }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Minimal, system-wide "is this MPR No already used, and under which Job" lookup —
  // available to every authenticated user (not just Admin), since a User needs this to
  // avoid picking an MPR No someone else already entered. Deliberately leaves out
  // created_by / user_name so it doesn't turn into a way to browse other users' entries.
  app.get("/api/entries/mpr-usage", authenticateToken, async (req: any, res) => {
    try {
      // used_by_other: whether THIS particular usage row belongs to a DIFFERENT user
      // than the caller — deliberately not the creator's name/id (see comment above),
      // just a boolean. An MPR No already used only by the calling user themself is
      // still reusable (to requisition the remaining Qty of an Item under it with a
      // new Delivery Date); one used by someone else stays blocked, same as before.
      const sql = `
        SELECT e.mpr_id, m.mpr_no, j.job_no, e.job_name, p.project_name, e.entry_date,
          (e.created_by <> ?) AS used_by_other
        FROM entries e
        JOIN mpr_numbers m ON e.mpr_id = m.id
        JOIN projects p ON e.project_id = p.id
        JOIN jobs j ON e.job_id = j.id
        WHERE e.deleted_at IS NULL
      `;
      const rows = await queryDB(sql, [req.user.id]);
      res.json(rows.map((r: any) => ({ ...r, used_by_other: !!Number(r.used_by_other) })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Job Recycle bin — every soft-deleted entry (Admin-only). Mirrors the GET
  // /api/entries join so the Admin sees the exact same detail (Item Name,
  // Specification, Qty, etc.) plus who deleted it and when, with a Restore option.
  app.get("/api/entries/recycle", authenticateToken, requireAdmin, requireModule("recycle"), async (req, res) => {
    try {
      let sql = `
        SELECT e.*, p.project_name, j.job_no, j.job_duration, m.mpr_no, u.name as user_name, b.budget_name,
          d.name as deleted_by_name,
          bi.sl_no AS bi_sl_no, bi.req_no AS bi_req_no, bi.item_date AS bi_item_date,
          bi.specification, bi.req_qty, bi.unit, bi.po_qty, bi.received_qty, bi.balance_qty,
          bi.entry_user AS bi_entry_user, bi.approved_date AS bi_approved_date,
          bi.app_user AS bi_app_user, bi.site_sup_date
        FROM entries e
        JOIN projects p ON e.project_id = p.id
        JOIN jobs j ON e.job_id = j.id
        JOIN mpr_numbers m ON e.mpr_id = m.id
        LEFT JOIN users u ON e.created_by = u.id
        LEFT JOIN users d ON e.deleted_by = d.id
        LEFT JOIN budgets b ON e.budget_id = b.id
        LEFT JOIN budget_items bi ON bi.id = COALESCE(
          e.budget_item_id,
          (
            SELECT bi2.id FROM budget_items bi2
            WHERE bi2.budget_id = e.budget_id AND LOWER(TRIM(bi2.mrf_no)) = LOWER(TRIM(m.mpr_no))
              AND LOWER(TRIM(bi2.description)) = LOWER(TRIM(e.item_name))
            ORDER BY bi2.id ASC LIMIT 1
          )
        )
        WHERE e.deleted_at IS NOT NULL
        ORDER BY e.deleted_at DESC, e.id DESC
      `;
      const entries = await queryDB(sql);
      res.json(entries);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/entries", authenticateToken, requireBudgetModuleAccess, async (req: any, res) => {
    try {
      // job_name is now typed by the user (not auto-generated).
      // job_no is now assigned automatically by the server (not typed by the user).
      // "items" is a list of { mpr_id, item_name, delivery_date } — one Job Name / Job No
      // can carry multiple MPR Nos in a single submission, each with its own delivery date.
      // budget_id: the User must first pick a Budget the Admin has created & imported —
      // every entry is now created FROM that Budget and is validated against it below.
      const { budget_id, project_id, job_name, job_duration, items } = req.body;

      if (
        !budget_id ||
        !project_id ||
        !job_name ||
        !String(job_name).trim() ||
        !job_duration ||
        !String(job_duration).trim() ||
        !Array.isArray(items) ||
        items.length === 0
      ) {
        return res.status(400).json({
          error: "Budget, Project, Job Name, Job Duration and at least one MPR No entry are required"
        });
      }

      // The Budget must exist and must actually have imported line items — a Budget
      // that's only been named but never had an Excel imported into it has nothing
      // valid to enter yet.
      const budgetRows = await queryDB("SELECT id FROM budgets WHERE id = ?", [budget_id]);
      if (budgetRows.length === 0) {
        return res.status(400).json({ error: "Invalid Budget selected. Please choose from the list." });
      }

      // Once THIS user has submitted this Budget (marked it as finished), block any
      // further entries from them under it — enforced here too, not just hidden in the
      // UI, so it can't be bypassed via a direct API call.
      const submittedRows = await queryDB("SELECT * FROM budget_submissions WHERE budget_id = ? AND user_id = ?", [
        budget_id,
        req.user.id
      ]);
      if (submittedRows.length > 0) {
        return res.status(400).json({
          error: "This Budget has already been submitted. No further entries can be added to it."
        });
      }

      const budgetItemRows = await queryDB(
        "SELECT mrf_no FROM budget_items WHERE budget_id = ? AND mrf_no IS NOT NULL AND mrf_no <> ''",
        [budget_id]
      );
      if (budgetItemRows.length === 0) {
        return res.status(400).json({ error: "This Budget has no imported MPR/MRF Nos yet." });
      }
      const allowedMprNosForBudget = new Set(
        budgetItemRows.map((r: any) => String(r.mrf_no).trim().toLowerCase())
      );

      for (const it of items) {
        if (
          !it ||
          !it.mpr_id ||
          !it.budget_item_id ||
          !it.item_name ||
          !String(it.item_name).trim() ||
          !it.delivery_date ||
          it.requisitioned_qty === undefined ||
          it.requisitioned_qty === null ||
          String(it.requisitioned_qty).trim() === "" ||
          !(Number(it.requisitioned_qty) > 0)
        ) {
          return res.status(400).json({
            error: "Every MPR row needs an MPR No, Item Name, a Requisitioned Qty greater than 0, and a Delivery Date"
          });
        }
      }

      // Every item must point at a REAL imported Budget Excel row (budget_items.id)
      // belonging to this Budget + this MPR No — this is what lets two rows share the
      // exact same Description of Materials text and still be entered as two separate
      // entries (each pinned to its own source row), instead of collapsing into one.
      // Also re-derive item_name from that row server-side so a direct API call can't
      // smuggle in arbitrary text under a valid budget_item_id.
      const allBudgetItemRows = await queryDB(
        "SELECT id, mrf_no, description, req_qty FROM budget_items WHERE budget_id = ?",
        [budget_id]
      );
      const validItemsById = new Map<number, any>(allBudgetItemRows.map((r: any) => [Number(r.id), r]));
      const mprNoById = new Map<number, string>();
      for (const it of items) {
        const row = validItemsById.get(Number(it.budget_item_id));
        if (!row) {
          return res.status(400).json({
            error: "One of the selected Items no longer matches the imported Budget Excel. Please refresh and try again."
          });
        }
        if (!mprNoById.has(Number(it.mpr_id))) {
          const mprRowForCheck = await queryDB("SELECT mpr_no FROM mpr_numbers WHERE id = ?", [it.mpr_id]);
          mprNoById.set(Number(it.mpr_id), mprRowForCheck[0]?.mpr_no || "");
        }
        const mprNoForCheck = mprNoById.get(Number(it.mpr_id)) || "";
        if (String(row.mrf_no).trim().toLowerCase() !== String(mprNoForCheck).trim().toLowerCase()) {
          return res.status(400).json({
            error: "One of the selected Items does not belong to the selected MPR No."
          });
        }
        // Trust the DB's own Description text, not whatever the client sent.
        it.item_name = String(row.description || "").trim();
      }

      // Cap each item's Requisitioned Qty against its own imported req_qty, PER USER —
      // this user's requested Qty here plus whatever they've already requisitioned
      // against this exact budget_item_id (in earlier, still-active entries) must not
      // exceed the item's original imported Qty. This is what lets the same Item (and
      // its MPR No) be entered again later for the remaining balance, with its own
      // Delivery Date, once an earlier entry against it is edited down.
      // Two rows in the SAME submission can now legitimately share a budget_item_id —
      // the client's "Add new row for the remaining Qty" split lets one Item's Qty be
      // sent under two Delivery Dates in one Job. So this cap has to be checked against
      // each item's COMBINED requested Qty across the whole batch, not row-by-row —
      // checking each row in isolation would let two large rows each individually pass
      // (both under `remaining`) while their sum quietly exceeds what's actually left.
      const batchTotalsByItem = new Map<number, number>();
      for (const it of items) {
        const key = Number(it.budget_item_id);
        batchTotalsByItem.set(key, (batchTotalsByItem.get(key) || 0) + Number(it.requisitioned_qty));
      }
      const checkedItemIds = new Set<number>();
      for (const it of items) {
        const key = Number(it.budget_item_id);
        if (checkedItemIds.has(key)) continue;
        checkedItemIds.add(key);
        const row = validItemsById.get(key);
        const totalQty = parseQtyNumber(row?.req_qty);
        if (totalQty !== null) {
          const consumedRows = await queryDB(
            "SELECT COALESCE(SUM(requisitioned_qty), 0) AS consumed FROM entries WHERE budget_item_id = ? AND created_by = ? AND deleted_at IS NULL",
            [key, req.user.id]
          );
          const consumed = Number(consumedRows[0]?.consumed || 0);
          const remaining = totalQty - consumed;
          const requestedTotal = batchTotalsByItem.get(key) || 0;
          if (requestedTotal > remaining + 0.001) {
            return res.status(400).json({
              error: `Requisitioned Qty for "${it.item_name}" can't exceed the remaining available Qty (${remaining}).`
            });
          }
        }
      }

      // If the Admin has set an allowed Delivery Date window for this Budget, every
      // MPR row's Delivery Date must fall inside it (inclusive) — enforced here too,
      // not just as a min/max on the client's date picker, so it can't be bypassed
      // via a direct API call.
      const rangeRows = await queryDB("SELECT delivery_date_from, delivery_date_to FROM budgets WHERE id = ?", [
        budget_id
      ]);
      const deliveryFrom = toDateOnlyString(rangeRows[0]?.delivery_date_from);
      const deliveryTo = toDateOnlyString(rangeRows[0]?.delivery_date_to);
      if (deliveryFrom || deliveryTo) {
        for (const it of items) {
          const d = String(it.delivery_date).slice(0, 10);
          if ((deliveryFrom && d < deliveryFrom) || (deliveryTo && d > deliveryTo)) {
            return res.status(400).json({
              error: `Delivery Date must be between ${deliveryFrom || "—"} and ${deliveryTo || "—"} for this Budget.`
            });
          }
        }
      }

      // An MPR No that carries several imported Excel rows (even ones that share the
      // exact same Description of Materials text) is now submitted as several items
      // sharing that same mpr_id, one per Excel row (budget_item_id) — that's expected,
      // not a duplicate. It's also expected for the SAME budget_item_id to appear
      // MULTIPLE TIMES under the SAME mpr_id — that's the client's "Split remaining
      // Qty to a new row" feature (see splitLeftoverToNewRow in UserPanel.tsx), which
      // can be used repeatedly to spread one Item's Qty across as many rows/Delivery
      // Dates as needed. There's no fixed cap on how many rows a pair can span — the
      // combined-Qty check above (batchTotalsByItem vs. remaining) already guarantees
      // the rows' Qtys can never add up to more than what was actually available, so
      // that's the only guard needed here; no separate per-pair row-count rejection.

      // Entry date is always today's date — users cannot edit or backdate it.
      const entry_date = todayInDhaka();

      // Enforce that Project Name and every MPR No must come from the Admin-managed lists —
      // this blocks bypassing the dropdown restriction via a direct API call.
      const projectRows = await queryDB("SELECT id, project_name FROM projects WHERE id = ?", [project_id]);
      if (projectRows.length === 0) {
        return res.status(400).json({ error: "Invalid Project selected. Please choose from the list." });
      }
      const projectName = projectRows[0].project_name;

      // Every MPR No must have been imported specifically under this Project within the
      // selected Budget's sheet (a Budget sheet can carry rows for several Projects) —
      // this scopes the MPR No choices to the selected Project, matching the dropdown.
      const projectBudgetItemRows = await queryDB(
        "SELECT mrf_no FROM budget_items WHERE budget_id = ? AND LOWER(TRIM(project_name)) = LOWER(TRIM(?)) AND mrf_no IS NOT NULL AND mrf_no <> ''",
        [budget_id, projectName]
      );
      const allowedMprNosForProject = new Set(
        projectBudgetItemRows.map((r: any) => String(r.mrf_no).trim().toLowerCase())
      );

      // Non-admin users can only submit entries for a project the Admin has granted
      // them access to — enforced here too, not just hidden in the dropdown, so it
      // can't be bypassed with a direct API call.
      if (req.user.role !== "admin" && req.user.role !== "superadmin") {
        const permRows = await queryDB(
          "SELECT id FROM user_project_permissions WHERE user_id = ? AND project_id = ?",
          [req.user.id, project_id]
        );
        if (permRows.length === 0) {
          return res.status(403).json({ error: "You don't have permission to submit entries for this project." });
        }
      }

      for (const it of items) {
        const mprRows = await queryDB("SELECT id, mpr_no FROM mpr_numbers WHERE id = ?", [it.mpr_id]);
        if (mprRows.length === 0) {
          return res.status(400).json({ error: "Invalid MPR No selected. Please choose from the list." });
        }
        // Enforce that the MPR No actually belongs to the selected Budget's imported
        // sheet — blocks entering an MPR No from a different Budget via a direct API call.
        if (!allowedMprNosForBudget.has(String(mprRows[0].mpr_no).trim().toLowerCase())) {
          return res.status(400).json({
            error: `MPR No "${mprRows[0].mpr_no}" was not imported into the selected Budget.`
          });
        }
        // Enforce that the MPR No was specifically imported under the selected Project
        // (not just somewhere else in the same Budget sheet) — blocks picking an MPR No
        // that belongs to a different Project via a direct API call.
        if (!allowedMprNosForProject.has(String(mprRows[0].mpr_no).trim().toLowerCase())) {
          return res.status(400).json({
            error: `MPR No "${mprRows[0].mpr_no}" does not belong to the selected Project "${projectName}".`
          });
        }
      }

      // An MPR No can only ever be used ONCE, system-wide, full stop — reject it here
      // too if it's already attached to ANY earlier entry (this same user's own, under
      // this Job or any other, or a different user's) under THIS SAME Budget, so the
      // dropdown restriction can't be bypassed via a direct API call. It's never
      // reusable again afterwards by anyone, including whoever used it originally. The
      // same MPR No is still allowed again once it's used under a different Budget.
      for (const it of items) {
        // Deleted entries free up their MPR No for reuse — only an active (non-deleted)
        // entry counts as "already used".
        const usedRows = await queryDB(
          "SELECT id FROM entries WHERE mpr_id = ? AND budget_id = ? AND deleted_at IS NULL",
          [it.mpr_id, budget_id]
        );
        if (usedRows.length > 0) {
          return res.status(400).json({
            warning: true,
            error: "One of the selected MPR Nos has already been used in another entry under this Budget."
          });
        }
      }

      // 1. Auto-generate a Job No sequential PER USER PER BUDGET (e.g. JOB-0001,
      // JOB-0002 ... for THIS user under THIS Budget specifically) — so every user's
      // own submissions start again from JOB-0001 independently of what any other user
      // is on, AND start again from JOB-0001 whenever they move to a different Budget.
      const jobCountRows = await queryDB("SELECT COUNT(*) as cnt FROM jobs WHERE created_by = ? AND budget_id = ?", [
        req.user.id,
        budget_id
      ]);
      const nextJobSeq = (jobCountRows[0]?.cnt || 0) + 1;
      const job_no = `JOB-${String(nextJobSeq).padStart(4, "0")}`;

      // 2. Create one Job for this submission (Job No is unique per user PER BUDGET,
      // not globally and not just per user)
      const jobResult = await queryDB(
        "INSERT INTO jobs (job_no, job_duration, created_by, budget_id) VALUES (?, ?, ?, ?)",
        [job_no, String(job_duration).trim(), req.user.id, budget_id]
      );
      const jobId = jobResult.insertId;

      // 3. Insert one entry per MPR No — all sharing this Job Name + Job No, and all
      // tagged with the Budget they were created from + the User who created them.
      const insertedIds: number[] = [];
      for (const it of items) {
        const result = await queryDB(
          `INSERT INTO entries (entry_date, job_name, budget_id, project_id, job_id, mpr_id, budget_item_id, item_name, requisitioned_qty, delivery_date, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry_date,
            String(job_name).trim(),
            budget_id,
            project_id,
            jobId,
            it.mpr_id,
            it.budget_item_id,
            String(it.item_name).trim(),
            Number(it.requisitioned_qty),
            it.delivery_date,
            req.user.id
          ]
        );
        insertedIds.push(result.insertId);
      }

      res.json({
        success: true,
        job_no,
        job_name: String(job_name).trim(),
        budget_id,
        entry_date,
        count: insertedIds.length,
        ids: insertedIds
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to save entry" });
    }
  });

  // "Job Edit" — add a new MPR row into an EXISTING Job (unlike POST /api/entries,
  // which always creates a brand-new Job). This is what lets a user extend a Job that
  // was already Final Submitted. Before the owning user has Final Submitted the
  // Job's Budget, this is just a normal part of entering data (same as
  // POST /api/entries) — no extra permission needed. Once that Budget HAS been
  // Final Submitted, adding to a Job is gated on can_job_edit (Admin Panel ->
  // Users) for non-admins, matching "user add edit delete kichui korte parbe na"
  // if the Admin hasn't turned Job Edit on for them.
  app.post("/api/entries/job/:jobId/items", authenticateToken, async (req: any, res) => {
    try {
      const jobId = Number(req.params.jobId);
      const { items } = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "At least one MPR row is required" });
      }

      const jobRows = await queryDB("SELECT * FROM jobs WHERE id = ?", [jobId]);
      if (jobRows.length === 0) return res.status(404).json({ error: "Job not found" });
      const job = jobRows[0];

      if (req.user.role !== "admin" && req.user.role !== "superadmin" && job.created_by !== req.user.id) {
        return res.status(403).json({ error: "You can only edit your own Jobs." });
      }
      if (req.user.role !== "admin" && req.user.role !== "superadmin") {
        // Only require can_job_edit once the owner has ALREADY Final Submitted this
        // Job's Budget — before that, adding another MPR to your own not-yet-locked
        // Job needs no special permission, same as creating one in the first place.
        const ownSubmissionRows = await queryDB(
          "SELECT id FROM budget_submissions WHERE budget_id = ? AND user_id = ?",
          [job.budget_id, req.user.id]
        );
        const budgetAlreadySubmitted = ownSubmissionRows.length > 0;
        if (budgetAlreadySubmitted) {
          const permRows = await queryDB("SELECT can_job_edit FROM users WHERE id = ?", [req.user.id]);
          const canJobEdit = permRows.length > 0 && !!Number(permRows[0].can_job_edit);
          if (!canJobEdit) {
            return res.status(403).json({ error: "You don't have permission to edit Jobs. Ask your Admin to enable Job Edit for your account." });
          }
        }
      }

      const budget_id = job.budget_id;
      if (!budget_id) {
        return res.status(400).json({ error: "This Job isn't linked to a Budget, so items can't be added to it." });
      }

      // A Job's entries all share one Project (set when the Job was first created) —
      // pull it from any existing (non-deleted) entry under this Job.
      const anyEntryRows = await queryDB(
        "SELECT project_id, job_name FROM entries WHERE job_id = ? AND deleted_at IS NULL LIMIT 1",
        [jobId]
      );
      if (anyEntryRows.length === 0) {
        return res.status(400).json({ error: "This Job has no active MPR entries to attach to." });
      }
      const project_id = anyEntryRows[0].project_id;
      const job_name = anyEntryRows[0].job_name;

      for (const it of items) {
        if (
          !it ||
          !it.mpr_id ||
          !it.budget_item_id ||
          !it.delivery_date ||
          it.requisitioned_qty === undefined ||
          it.requisitioned_qty === null ||
          String(it.requisitioned_qty).trim() === "" ||
          !(Number(it.requisitioned_qty) > 0)
        ) {
          return res.status(400).json({
            error: "Every MPR row needs an MPR No, an Item, a Requisitioned Qty greater than 0, and a Delivery Date"
          });
        }
      }

      // Every item must point at a REAL imported Budget Excel row belonging to this
      // Budget, and match the selected MPR No — same validation as creating a new Job.
      const allBudgetItemRows = await queryDB(
        "SELECT id, mrf_no, description, req_qty FROM budget_items WHERE budget_id = ?",
        [budget_id]
      );
      const validItemsById = new Map<number, any>(allBudgetItemRows.map((r: any) => [Number(r.id), r]));
      const mprNoById = new Map<number, string>();
      for (const it of items) {
        const row = validItemsById.get(Number(it.budget_item_id));
        if (!row) {
          return res.status(400).json({
            error: "One of the selected Items no longer matches the imported Budget Excel. Please refresh and try again."
          });
        }
        if (!mprNoById.has(Number(it.mpr_id))) {
          const mprRowForCheck = await queryDB("SELECT mpr_no FROM mpr_numbers WHERE id = ?", [it.mpr_id]);
          mprNoById.set(Number(it.mpr_id), mprRowForCheck[0]?.mpr_no || "");
        }
        const mprNoForCheck = mprNoById.get(Number(it.mpr_id)) || "";
        if (String(row.mrf_no).trim().toLowerCase() !== String(mprNoForCheck).trim().toLowerCase()) {
          return res.status(400).json({ error: "One of the selected Items does not belong to the selected MPR No." });
        }
        it.item_name = String(row.description || "").trim();
      }

      // Cap each item's Requisitioned Qty against remaining Qty, PER USER — same rule
      // as creating a new Job (see POST /api/entries for the full explanation).
      const batchTotalsByItem = new Map<number, number>();
      for (const it of items) {
        const key = Number(it.budget_item_id);
        batchTotalsByItem.set(key, (batchTotalsByItem.get(key) || 0) + Number(it.requisitioned_qty));
      }
      const checkedItemIds = new Set<number>();
      for (const it of items) {
        const key = Number(it.budget_item_id);
        if (checkedItemIds.has(key)) continue;
        checkedItemIds.add(key);
        const row = validItemsById.get(key);
        const totalQty = parseQtyNumber(row?.req_qty);
        if (totalQty !== null) {
          const consumedRows = await queryDB(
            "SELECT COALESCE(SUM(requisitioned_qty), 0) AS consumed FROM entries WHERE budget_item_id = ? AND created_by = ? AND deleted_at IS NULL",
            [key, job.created_by]
          );
          const consumed = Number(consumedRows[0]?.consumed || 0);
          const remaining = totalQty - consumed;
          const requestedTotal = batchTotalsByItem.get(key) || 0;
          if (requestedTotal > remaining + 0.001) {
            return res.status(400).json({
              error: `Requisitioned Qty for "${it.item_name}" can't exceed the remaining available Qty (${remaining}).`
            });
          }
        }
      }

      // Admin-set Delivery Date window for the Budget, if any.
      const rangeRows = await queryDB("SELECT delivery_date_from, delivery_date_to FROM budgets WHERE id = ?", [
        budget_id
      ]);
      const deliveryFrom = toDateOnlyString(rangeRows[0]?.delivery_date_from);
      const deliveryTo = toDateOnlyString(rangeRows[0]?.delivery_date_to);
      if (deliveryFrom || deliveryTo) {
        for (const it of items) {
          const d = String(it.delivery_date).slice(0, 10);
          if ((deliveryFrom && d < deliveryFrom) || (deliveryTo && d > deliveryTo)) {
            return res.status(400).json({
              error: `Delivery Date must be between ${deliveryFrom || "—"} and ${deliveryTo || "—"} for this Budget.`
            });
          }
        }
      }
      // Every new MPR row added here is dated today (entry_date, set further below) —
      // its Delivery Date can never be earlier than today, mirroring the min/max
      // already enforced on the client's date picker.
      {
        const today = todayInDhaka();
        for (const it of items) {
          const d = String(it.delivery_date).slice(0, 10);
          if (d < today) {
            return res.status(400).json({ error: `Delivery Date can't be earlier than today (${today}).` });
          }
        }
      }

      // An MPR No can only ever be used ONCE, system-wide — same rule as creation.
      for (const it of items) {
        const usedRows = await queryDB(
          "SELECT id FROM entries WHERE mpr_id = ? AND budget_id = ? AND deleted_at IS NULL",
          [it.mpr_id, budget_id]
        );
        if (usedRows.length > 0) {
          return res.status(400).json({
            error: "One of the selected MPR Nos has already been used in another entry under this Budget."
          });
        }
      }

      const entry_date = todayInDhaka();
      const insertedIds: number[] = [];
      for (const it of items) {
        const result = await queryDB(
          `INSERT INTO entries (entry_date, job_name, budget_id, project_id, job_id, mpr_id, budget_item_id, item_name, requisitioned_qty, delivery_date, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry_date,
            job_name,
            budget_id,
            project_id,
            jobId,
            it.mpr_id,
            it.budget_item_id,
            it.item_name,
            Number(it.requisitioned_qty),
            it.delivery_date,
            job.created_by
          ]
        );
        insertedIds.push(result.insertId);
        // So an Admin/Superadmin can see, in the "MPR Edit Log" tab, exactly which new
        // MPR rows were added into an already Final-Submitted Job via Job Edit, by
        // whom, and when — not just edits to EXISTING rows (which the PUT endpoint
        // below already logs). old_value is blank since there was nothing before it;
        // new_value carries the Qty/Delivery Date, since Item Name, MPR No and Job No
        // are already available via the entry join in GET /api/entries/edit-history.
        await queryDB(
          "INSERT INTO entry_edit_history (entry_id, edited_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)",
          [
            result.insertId,
            req.user.id,
            "job_edit_add",
            "",
            `Qty: ${it.requisitioned_qty}, Delivery Date: ${it.delivery_date}`
          ]
        );
      }

      res.json({ success: true, job_id: jobId, count: insertedIds.length, ids: insertedIds });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to add MPR to Job" });
    }
  });

  // Edit an existing MPR entry. Item Name and Delivery Date are always required; Job
  // Name, Job Duration and MPR No are optional in the request body and only touched
  // when the client actually sends a changed value (undefined = leave as-is). Allowed
  // only for the User who created it. Before THIS user's Final Submit ("Submit Budget")
  // of the Budget it belongs to, every field is freely editable — including MPR No,
  // Item, Qty, Job Name and Job Duration on a row already attached to a Job. Once that
  // Budget has been Final Submitted, this locks down to Delivery-Date-only, same as
  // before — unless that user has the Job Edit permission, which still only unlocks
  // Add/Delete of MPR rows on a Final-Submitted Job, not editing an existing row's
  // other fields.
  // Job Name and Job Duration are shared by every MPR row of the same Job, so a change
  // to either is applied — and logged in entry_edit_history — for every entry under
  // that Job, not just the row that was open when the edit was made.
  app.put("/api/entries/:id", authenticateToken, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { item_name, delivery_date, job_name, job_duration, mpr_id, budget_item_id, requisitioned_qty } = req.body;

      if (!item_name || !String(item_name).trim() || !delivery_date) {
        return res.status(400).json({ error: "Item Name and Delivery Date are required" });
      }
      // requisitioned_qty is optional in the request body (older callers that don't
      // send it leave the entry's existing Qty untouched), but if it IS sent it must
      // be a positive number — capped against the item's remaining Qty further below.
      const qtyProvided =
        requisitioned_qty !== undefined && requisitioned_qty !== null && String(requisitioned_qty).trim() !== "";
      if (qtyProvided && !(Number(requisitioned_qty) > 0)) {
        return res.status(400).json({ error: "Requisitioned Qty must be greater than 0" });
      }
      if (job_name !== undefined && !String(job_name).trim()) {
        return res.status(400).json({ error: "Job Name cannot be empty" });
      }
      if (job_duration !== undefined && !String(job_duration).trim()) {
        return res.status(400).json({ error: "Job Duration cannot be empty" });
      }

      const rows = await queryDB(
        `SELECT e.*, j.job_duration AS current_job_duration, m.mpr_no AS current_mpr_no
         FROM entries e
         JOIN jobs j ON e.job_id = j.id
         JOIN mpr_numbers m ON e.mpr_id = m.id
         WHERE e.id = ?`,
        [id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Entry not found" });
      const entry = rows[0];

      // Only the owner (or an Admin) can edit — an Admin can edit any entry.
      if (req.user.role !== "admin" && req.user.role !== "superadmin" && entry.created_by !== req.user.id) {
        return res.status(403).json({ error: "You can only edit your own entries." });
      }

      // Fetch this user's own feature-permission flags fresh (not from the JWT, which
      // can be up to 7 days stale) so an Admin toggling them takes effect immediately.
      let canEditDeliveryDate = true;
      let canJobEdit = false;
      if (req.user.role !== "admin" && req.user.role !== "superadmin") {
        const permRows = await queryDB("SELECT can_edit_delivery_date, can_job_edit FROM users WHERE id = ?", [
          req.user.id
        ]);
        if (permRows.length > 0) {
          canEditDeliveryDate = permRows[0].can_edit_delivery_date === undefined || !!Number(permRows[0].can_edit_delivery_date);
          canJobEdit = !!Number(permRows[0].can_job_edit);
        }
      }

      // Once this entry's Budget has been submitted (by the user who owns the entry)
      // it's "Final Submitted" / locked. Job Edit (can_job_edit) does NOT unlock
      // editing an existing entry's fields here — it only unlocks adding a new MPR
      // (POST /api/entries/job/:jobId/items) and deleting one (DELETE below). Editing
      // an existing row stays Delivery-Date-only, exactly like the pre-lock stage,
      // gated by can_edit_delivery_date — so a non-admin is blocked here entirely
      // only if they have NEITHER permission at all.
      let budgetLocked = false;
      if (entry.budget_id && req.user.role !== "admin" && req.user.role !== "superadmin") {
        const submittedRows = await queryDB(
          "SELECT id FROM budget_submissions WHERE budget_id = ? AND user_id = ?",
          [entry.budget_id, entry.created_by]
        );
        budgetLocked = submittedRows.length > 0;
        if (budgetLocked && !canJobEdit && !canEditDeliveryDate) {
          return res.status(400).json({
            error: "This entry's Budget has already been submitted. It can no longer be edited."
          });
        }
      }

      // An Admin always gets a truly unrestricted edit here. A regular User/owner is
      // ALSO fully unrestricted as long as their Budget hasn't been Final Submitted yet
      // (budgetLocked === false) — before that point, every field (MPR No, Item, Qty,
      // Job Name, Job Duration, Delivery Date) stays freely editable, including for
      // entries already attached to a Job ("Add MPR to Job" / Job creation does not by
      // itself lock a row). can_job_edit is NOT part of this — once the Budget IS Final
      // Submitted, can_job_edit never allows Requisitioned Qty (or any other field
      // besides Delivery Date) to change on an EXISTING row; it only unlocks Add/Delete
      // of MPR rows on an otherwise-locked, Final-Submitted Job.
      const fullyUnlocked = req.user.role === "admin" || req.user.role === "superadmin" || !budgetLocked;

      // Once this entry's Budget has been Final Submitted, a non-admin User without Job
      // Edit can only ever change its Delivery Date — Job Name, Job Duration, MPR No,
      // Item Name/selection and Requisitioned Qty are all locked from that point on. If
      // the user doesn't even have the Delivery Date permission, Delivery Date is locked
      // too. The UI no longer offers inputs for the locked fields, but that alone
      // doesn't stop a direct API call, so re-check here: any of these fields sent with
      // a value different from what's already stored is rejected outright.
      if (!fullyUnlocked) {
        const lockedMismatches: string[] = [];
        if (item_name !== undefined && String(item_name).trim() !== String(entry.item_name)) {
          lockedMismatches.push("Item Name");
        }
        if (job_name !== undefined && String(job_name).trim() !== String(entry.job_name)) {
          lockedMismatches.push("Job Name");
        }
        if (job_duration !== undefined && String(job_duration).trim() !== String(entry.current_job_duration)) {
          lockedMismatches.push("Job Duration");
        }
        if (mpr_id !== undefined && Number(mpr_id) !== Number(entry.mpr_id)) {
          lockedMismatches.push("MPR No");
        }
        if (
          budget_item_id !== undefined &&
          budget_item_id !== null &&
          Number(budget_item_id) !== Number(entry.budget_item_id)
        ) {
          lockedMismatches.push("Item selection");
        }
        if (qtyProvided && Number(requisitioned_qty) !== Number(entry.requisitioned_qty)) {
          lockedMismatches.push("Requisitioned Qty");
        }
        const newDeliveryDateForCheck = String(delivery_date).slice(0, 10);
        const oldDeliveryDateForCheck = toDateOnlyString(entry.delivery_date) || "";
        if (!canEditDeliveryDate && newDeliveryDateForCheck !== oldDeliveryDateForCheck) {
          lockedMismatches.push("Delivery Date");
        }
        if (lockedMismatches.length > 0) {
          return res.status(400).json({
            error: `Only Delivery Date can be edited after an entry is submitted. (${lockedMismatches.join(", ")} cannot be changed.)`
          });
        }
      }

      // --- Resolve the effective MPR No for this save (unchanged unless mpr_id given) ---
      let effectiveMprId = entry.mpr_id;
      let effectiveMprNo = entry.current_mpr_no;
      const mprChanged = mpr_id !== undefined && Number(mpr_id) !== Number(entry.mpr_id);
      if (mprChanged) {
        const newMprRows = await queryDB("SELECT id, mpr_no FROM mpr_numbers WHERE id = ?", [mpr_id]);
        if (newMprRows.length === 0) {
          return res.status(400).json({ error: "Invalid MPR No selected. Please choose from the list." });
        }
        // An MPR No can only ever be used ONCE, system-wide — same rule as creation,
        // scoped to this entry's own Budget, excluding this entry itself (re-selecting
        // its own current MPR No must stay allowed) and any deleted entry (deleted
        // entries free up their MPR No for reuse). Never reusable again afterwards by
        // anyone, including this entry's own owner under a different entry/Job.
        const usedRows = await queryDB(
          "SELECT id FROM entries WHERE mpr_id = ? AND budget_id = ? AND id <> ? AND deleted_at IS NULL",
          [mpr_id, entry.budget_id, id]
        );
        if (usedRows.length > 0) {
          return res.status(400).json({ error: "That MPR No has already been used in another entry under this Budget." });
        }
        // Must still belong to the same Budget + Project this entry was created under —
        // blocks smuggling in an MPR No from an unrelated Budget/Project via a direct API call.
        if (entry.budget_id) {
          const projRows = await queryDB("SELECT project_name FROM projects WHERE id = ?", [entry.project_id]);
          const projectName = projRows[0]?.project_name || "";
          const allowedRows = await queryDB(
            "SELECT id FROM budget_items WHERE budget_id = ? AND LOWER(TRIM(mrf_no)) = LOWER(TRIM(?)) AND LOWER(TRIM(project_name)) = LOWER(TRIM(?))",
            [entry.budget_id, newMprRows[0].mpr_no, projectName]
          );
          if (allowedRows.length === 0) {
            return res.status(400).json({
              error: `MPR No "${newMprRows[0].mpr_no}" was not imported for this Project under this entry's Budget.`
            });
          }
        }
        effectiveMprId = Number(mpr_id);
        effectiveMprNo = newMprRows[0].mpr_no;
      }

      // If the entry's Budget has an Admin-set Delivery Date window, the new Delivery
      // Date must still fall inside it (inclusive) — enforced here too, not just as a
      // min/max on the client's date picker, so it can't be bypassed via a direct API call.
      const newDeliveryDate = String(delivery_date).slice(0, 10);
      if (entry.budget_id) {
        const rangeRows = await queryDB("SELECT delivery_date_from, delivery_date_to FROM budgets WHERE id = ?", [
          entry.budget_id
        ]);
        const deliveryFrom = toDateOnlyString(rangeRows[0]?.delivery_date_from);
        const deliveryTo = toDateOnlyString(rangeRows[0]?.delivery_date_to);
        if ((deliveryFrom && newDeliveryDate < deliveryFrom) || (deliveryTo && newDeliveryDate > deliveryTo)) {
          return res.status(400).json({
            error: `Delivery Date must be between ${deliveryFrom || "—"} and ${deliveryTo || "—"} for this Budget.`
          });
        }
      }

      // A Delivery Date can never be moved to a point before the entry was created,
      // nor before today (the day of this edit) — only checked when the date is
      // actually being changed, so re-saving an old entry whose Delivery Date already
      // predates today (untouched) never breaks. Applies to every editor, including
      // Job Edit, mirroring the min/max already enforced on the client's date picker.
      const oldDeliveryDateForFloor = toDateOnlyString(entry.delivery_date) || "";
      if (newDeliveryDate !== oldDeliveryDateForFloor) {
        const entryDateStr = toDateOnlyString(entry.entry_date) || "";
        const floor = entryDateStr && entryDateStr > todayInDhaka() ? entryDateStr : todayInDhaka();
        if (newDeliveryDate < floor) {
          return res.status(400).json({
            error: `Delivery Date can't be earlier than ${floor} (the entry date / today).`
          });
        }
      }

      // If the entry came from a Budget, the new Item must still be one of that
      // Budget's imported Excel rows for the effective (possibly newly-picked) MPR No —
      // blocks typing in an arbitrary value via a direct API call. When the client sends
      // a specific budget_item_id (the normal path from the edit UI), pin to that EXACT
      // Excel row so entries with a duplicate Description text still resolve to their
      // own Specification/Qty; only falls back to a description-text match for older
      // callers that don't send budget_item_id.
      let effectiveBudgetItemId: number | null = entry.budget_item_id ?? null;
      if (entry.budget_id) {
        if (budget_item_id) {
          const validRows = await queryDB(
            "SELECT id, description FROM budget_items WHERE id = ? AND budget_id = ? AND LOWER(TRIM(mrf_no)) = LOWER(TRIM(?))",
            [budget_item_id, entry.budget_id, effectiveMprNo]
          );
          if (validRows.length === 0) {
            return res.status(400).json({
              error: "Item must be one of the rows imported for this MPR No in the Budget."
            });
          }
          effectiveBudgetItemId = Number(budget_item_id);
        } else {
          const validRows = await queryDB(
            "SELECT id FROM budget_items WHERE budget_id = ? AND LOWER(TRIM(mrf_no)) = LOWER(TRIM(?)) AND LOWER(TRIM(description)) = LOWER(TRIM(?))",
            [entry.budget_id, effectiveMprNo, item_name]
          );
          if (validRows.length === 0) {
            return res.status(400).json({
              error: "Item Name must be one of the Descriptions imported for this MPR No in the Budget."
            });
          }
          // No specific row chosen — leave budget_item_id as-is only if it still matches
          // this MPR No, otherwise clear it so GET /api/entries falls back to the
          // (now-ambiguous) description-text match rather than pointing at a stale row.
          if (mprChanged) effectiveBudgetItemId = null;
        }
      }

      // Cap the (possibly edited) Requisitioned Qty against the item's remaining
      // balance for this entry's OWNER — same rule as creation, excluding this entry's
      // own current Qty from the "already consumed" sum (since we're replacing it).
      let effectiveRequisitionedQty: number | null = entry.requisitioned_qty ?? null;
      if (qtyProvided && effectiveBudgetItemId) {
        const itemRows = await queryDB("SELECT req_qty FROM budget_items WHERE id = ?", [effectiveBudgetItemId]);
        const totalQty = parseQtyNumber(itemRows[0]?.req_qty);
        if (totalQty !== null) {
          const consumedRows = await queryDB(
            "SELECT COALESCE(SUM(requisitioned_qty), 0) AS consumed FROM entries WHERE budget_item_id = ? AND created_by = ? AND deleted_at IS NULL AND id <> ?",
            [effectiveBudgetItemId, entry.created_by, id]
          );
          const consumed = Number(consumedRows[0]?.consumed || 0);
          const remaining = totalQty - consumed;
          if (Number(requisitioned_qty) > remaining + 0.001) {
            return res.status(400).json({
              error: `Requisitioned Qty can't exceed the remaining available Qty (${remaining}).`
            });
          }
        }
        effectiveRequisitionedQty = Number(requisitioned_qty);
      }

      // --- Apply changes + record history (only for fields that actually changed) ---
      const editedBy = req.user.id;
      const rowHistory: { field: string; oldVal: string; newVal: string }[] = [];

      const trimmedItemName = String(item_name).trim();
      if (trimmedItemName !== String(entry.item_name)) {
        rowHistory.push({ field: "item_name", oldVal: entry.item_name, newVal: trimmedItemName });
      }
      const oldDeliveryDate = toDateOnlyString(entry.delivery_date) || "";
      if (newDeliveryDate !== oldDeliveryDate) {
        rowHistory.push({ field: "delivery_date", oldVal: oldDeliveryDate, newVal: newDeliveryDate });
      }
      if (mprChanged) {
        rowHistory.push({ field: "mpr_no", oldVal: entry.current_mpr_no, newVal: effectiveMprNo });
      }
      // Numeric comparison, not string — entry.requisitioned_qty comes back from a
      // DECIMAL column (e.g. the string "5.00"), while effectiveRequisitionedQty is a
      // plain JS number (e.g. 5). Comparing those as strings ("5" !== "5.00") falsely
      // flagged Requisitioned Qty as "changed" any time it was merely re-sent unchanged
      // (e.g. while only editing Delivery Date), polluting the Edit Log with entries
      // for a field that was never actually touched.
      const oldQtyNum =
        entry.requisitioned_qty === null || entry.requisitioned_qty === undefined ? null : Number(entry.requisitioned_qty);
      if (qtyProvided && Number(effectiveRequisitionedQty) !== oldQtyNum) {
        rowHistory.push({
          field: "requisitioned_qty",
          oldVal: oldQtyNum === null ? "" : String(oldQtyNum),
          newVal: String(effectiveRequisitionedQty)
        });
      }

      await queryDB(
        "UPDATE entries SET item_name = ?, delivery_date = ?, mpr_id = ?, budget_item_id = ?, requisitioned_qty = ? WHERE id = ?",
        [trimmedItemName, newDeliveryDate, effectiveMprId, effectiveBudgetItemId, effectiveRequisitionedQty, id]
      );
      for (const h of rowHistory) {
        await queryDB(
          "INSERT INTO entry_edit_history (entry_id, edited_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)",
          [id, editedBy, h.field, h.oldVal, h.newVal]
        );
      }

      // Job Name / Job Duration are shared by every MPR row under the same Job.
      const jobNameChanged = job_name !== undefined && String(job_name).trim() !== String(entry.job_name);
      const jobDurationChanged =
        job_duration !== undefined && String(job_duration).trim() !== String(entry.current_job_duration);

      if (jobNameChanged || jobDurationChanged) {
        const siblingRows = await queryDB("SELECT id FROM entries WHERE job_id = ?", [entry.job_id]);
        const siblingIds = siblingRows.map((s: any) => s.id);

        if (jobNameChanged) {
          const trimmedJobName = String(job_name).trim();
          await queryDB("UPDATE entries SET job_name = ? WHERE job_id = ?", [trimmedJobName, entry.job_id]);
          for (const sid of siblingIds) {
            await queryDB(
              "INSERT INTO entry_edit_history (entry_id, edited_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)",
              [sid, editedBy, "job_name", entry.job_name, trimmedJobName]
            );
          }
        }
        if (jobDurationChanged) {
          const trimmedJobDuration = String(job_duration).trim();
          await queryDB("UPDATE jobs SET job_duration = ? WHERE id = ?", [trimmedJobDuration, entry.job_id]);
          for (const sid of siblingIds) {
            await queryDB(
              "INSERT INTO entry_edit_history (entry_id, edited_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)",
              [sid, editedBy, "job_duration", entry.current_job_duration, trimmedJobDuration]
            );
          }
        }
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to update entry" });
    }
  });

  // Split an existing entry's Requisitioned Qty into two entries under the SAME Job +
  // MPR No + Item, each free to carry its own Delivery Date — mirrors the "Split
  // remaining Qty into a new item" feature already available while first creating a
  // Job (see splitLeftoverInSameRow in UserPanel.tsx), now available on an entry
  // that's already been saved, for as long as it's still fully editable (i.e. its
  // Budget hasn't been Final Submitted yet — same cutoff PUT /api/entries/:id uses for
  // full field-editing). can_job_edit does NOT unlock this once the Budget IS Final
  // Submitted — splitting an existing row's Qty is a structural change to an
  // already-locked row, not "adding a new MPR row" (POST /api/entries/job/:jobId/items).
  // The two resulting entries always add back up to exactly this entry's original Qty,
  // so nothing is created or lost against the Budget's imported balance.
  app.post("/api/entries/:id/split", authenticateToken, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { split_qty, split_delivery_date } = req.body;

      const rows = await queryDB("SELECT * FROM entries WHERE id = ?", [id]);
      if (rows.length === 0 || rows[0].deleted_at) return res.status(404).json({ error: "Entry not found" });
      const entry = rows[0];

      // Only the owner (or an Admin) can split — an Admin can split any entry.
      if (req.user.role !== "admin" && req.user.role !== "superadmin" && entry.created_by !== req.user.id) {
        return res.status(403).json({ error: "You can only edit your own entries." });
      }

      if (entry.budget_id && req.user.role !== "admin" && req.user.role !== "superadmin") {
        const submittedRows = await queryDB(
          "SELECT id FROM budget_submissions WHERE budget_id = ? AND user_id = ?",
          [entry.budget_id, entry.created_by]
        );
        if (submittedRows.length > 0) {
          return res.status(400).json({
            error: "This entry's Budget has already been submitted. It can no longer be split."
          });
        }
      }

      const currentQty =
        entry.requisitioned_qty === null || entry.requisitioned_qty === undefined ? null : Number(entry.requisitioned_qty);
      const splitQtyNum = Number(split_qty);
      if (currentQty === null || !(currentQty > 0)) {
        return res.status(400).json({ error: "This entry has no Requisitioned Qty to split." });
      }
      if (!Number.isFinite(splitQtyNum) || !(splitQtyNum > 0)) {
        return res.status(400).json({ error: "Enter a valid Qty to split off." });
      }
      // Both resulting rows must end up with something — splitting off the entire
      // Qty would just be moving the entry, not splitting it.
      if (splitQtyNum >= currentQty) {
        return res.status(400).json({
          error: `Qty to split off must be less than the entry's current Qty (${currentQty}) — some must remain on the original entry.`
        });
      }
      if (!split_delivery_date) {
        return res.status(400).json({ error: "Delivery Date is required for the split-off entry." });
      }

      // If the entry's Budget has an Admin-set Delivery Date window, the split-off
      // entry's Delivery Date must still fall inside it (inclusive) — same rule PUT
      // enforces on a normal edit.
      const newDeliveryDate = String(split_delivery_date).slice(0, 10);
      if (entry.budget_id) {
        const rangeRows = await queryDB("SELECT delivery_date_from, delivery_date_to FROM budgets WHERE id = ?", [
          entry.budget_id
        ]);
        const deliveryFrom = toDateOnlyString(rangeRows[0]?.delivery_date_from);
        const deliveryTo = toDateOnlyString(rangeRows[0]?.delivery_date_to);
        if ((deliveryFrom && newDeliveryDate < deliveryFrom) || (deliveryTo && newDeliveryDate > deliveryTo)) {
          return res.status(400).json({
            error: `Delivery Date must be between ${deliveryFrom || "—"} and ${deliveryTo || "—"} for this Budget.`
          });
        }
      }
      // Never earlier than today, mirroring every other Delivery Date entry point (the
      // split-off row is a brand-new entry, dated today, same as Add MPR to Job).
      const today = todayInDhaka();
      if (newDeliveryDate < today) {
        return res.status(400).json({ error: `Delivery Date can't be earlier than today (${today}).` });
      }

      const remainingQty = currentQty - splitQtyNum;

      // 1. Shrink the original entry down to whatever's left, logged exactly like any
      // other Requisitioned Qty edit.
      await queryDB("UPDATE entries SET requisitioned_qty = ? WHERE id = ?", [remainingQty, id]);
      await queryDB(
        "INSERT INTO entry_edit_history (entry_id, edited_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)",
        [id, req.user.id, "requisitioned_qty", String(currentQty), String(remainingQty)]
      );

      // 2. Insert the split-off portion as its own entry — same Job, MPR No and Item,
      // just its own Qty and Delivery Date. Deliberately bypasses the usual "MPR No can
      // only be used once" check (see POST /api/entries and .../job/:jobId/items): this
      // is the one legitimate case of two active entries sharing an MPR No, since
      // together they always add back up to exactly what the original entry held.
      const result = await queryDB(
        `INSERT INTO entries (entry_date, job_name, budget_id, project_id, job_id, mpr_id, budget_item_id, item_name, requisitioned_qty, delivery_date, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          today,
          entry.job_name,
          entry.budget_id,
          entry.project_id,
          entry.job_id,
          entry.mpr_id,
          entry.budget_item_id,
          entry.item_name,
          splitQtyNum,
          newDeliveryDate,
          entry.created_by
        ]
      );
      await queryDB(
        "INSERT INTO entry_edit_history (entry_id, edited_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)",
        [
          result.insertId,
          req.user.id,
          "split_from_entry",
          "",
          `Split from entry #${id} — Qty: ${splitQtyNum}, Delivery Date: ${newDeliveryDate}`
        ]
      );

      res.json({ success: true, new_entry_id: result.insertId, remaining_qty: remainingQty });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to split entry" });
    }
  });

  // Full change history for one entry row (Item Name, Delivery Date, MPR No, and any
  // Job Name / Job Duration edits made from this or a sibling row under the same Job).
  // Admin-only, per the Admin Panel's Reports tab.
  app.get("/api/entries/:id/history", authenticateToken, requireAdmin, requireModule("reports"), async (req, res) => {
    try {
      const { id } = req.params;
      const rows = await queryDB(
        `SELECT h.*, u.name AS editor_name
         FROM entry_edit_history h
         LEFT JOIN users u ON h.edited_by = u.id
         WHERE h.entry_id = ?
         ORDER BY h.edited_at DESC, h.id DESC`,
        [id]
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // System-wide edit log across EVERY entry — this is what powers the Admin Panel's
  // own "MPR Edit Log" tab, separate from the per-entry history popup above. Lets an
  // Admin see, across ALL Job Numbers / MPR Nos / Users, which day each edit happened
  // and what changed, without having to open each entry's history one at a time.
  // Joins in the entry's Job No and (current) MPR No so every row is identifiable even
  // after the entry itself has since been further edited or its owner has moved on.
  app.get("/api/entries/edit-history", authenticateToken, requireAdmin, requireModule("editlog"), async (req, res) => {
    try {
      const rows = await queryDB(
        `SELECT h.*, u.name AS editor_name,
                j.job_no, e.job_name, e.mpr_id, m.mpr_no, e.item_name,
                e.created_by AS entry_owner_id, ou.name AS entry_owner_name
         FROM entry_edit_history h
         JOIN entries e ON h.entry_id = e.id
         JOIN jobs j ON e.job_id = j.id
         JOIN mpr_numbers m ON e.mpr_id = m.id
         LEFT JOIN users u ON h.edited_by = u.id
         LEFT JOIN users ou ON e.created_by = ou.id
         ORDER BY h.edited_at DESC, h.id DESC`,
        []
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Entry deletion is now available to the User who owns the entry, not just the
  // Admin (an Admin can still delete any entry). It's a SOFT delete — the entry moves
  // into the Admin's Job Recycle bin (Reports -> Job Recycle) instead of being erased,
  // so an accidental delete can still be restored. Same lock rule as editing: once
  // this entry's Budget has been submitted by its owner, a non-admin can no longer
  // delete it either.
  app.delete("/api/entries/:id", authenticateToken, async (req: any, res) => {
    try {
      const { id } = req.params;
      const rows = await queryDB(
        `SELECT e.*, j.job_duration AS current_job_duration, m.mpr_no AS current_mpr_no
         FROM entries e
         JOIN jobs j ON e.job_id = j.id
         JOIN mpr_numbers m ON e.mpr_id = m.id
         WHERE e.id = ?`,
        [id]
      );
      if (rows.length === 0 || rows[0].deleted_at) {
        return res.status(404).json({ error: "Entry not found" });
      }
      const entry = rows[0];

      // Only the owner (or an Admin) can delete — an Admin can delete any entry.
      if (req.user.role !== "admin" && req.user.role !== "superadmin" && entry.created_by !== req.user.id) {
        return res.status(403).json({ error: "You can only delete your own entries." });
      }

      // Once this entry's Budget has been submitted (by the user who owns the entry),
      // it's locked — deleting must be blocked here too, same rule as editing. A
      // non-admin with the Job Edit permission (Admin Panel -> Users) is exempt: that
      // permission is specifically what lets them delete an MPR out of an already
      // Final-Submitted Job.
      if (entry.budget_id && req.user.role !== "admin" && req.user.role !== "superadmin") {
        const submittedRows = await queryDB(
          "SELECT id FROM budget_submissions WHERE budget_id = ? AND user_id = ?",
          [entry.budget_id, entry.created_by]
        );
        if (submittedRows.length > 0) {
          const permRows = await queryDB("SELECT can_job_edit FROM users WHERE id = ?", [req.user.id]);
          const canJobEdit = permRows.length > 0 && !!Number(permRows[0].can_job_edit);
          if (!canJobEdit) {
            return res.status(400).json({
              error: "This entry's Budget has already been submitted. It can no longer be deleted."
            });
          }
        }
      }

      await queryDB("UPDATE entries SET deleted_at = NOW(), deleted_by = ? WHERE id = ?", [req.user.id, id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to delete entry" });
    }
  });

  // Restore a soft-deleted entry out of the Job Recycle bin (Admin-only).
  app.post("/api/entries/:id/restore", authenticateToken, requireAdmin, requireModule("recycle"), async (req, res) => {
    try {
      const { id } = req.params;
      const rows = await queryDB("SELECT id, deleted_at FROM entries WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Entry not found" });
      if (!rows[0].deleted_at) return res.status(400).json({ error: "This entry is not in the Recycle bin." });

      await queryDB("UPDATE entries SET deleted_at = NULL, deleted_by = NULL WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to restore entry" });
    }
  });

  // Permanently erase an entry from the Job Recycle bin (Admin-only). Only allowed on
  // an entry that's already soft-deleted — this can't be used to bypass the soft
  // delete on an active entry.
  app.delete("/api/entries/:id/permanent", authenticateToken, requireAdmin, requireModule("recycle"), async (req, res) => {
    try {
      const { id } = req.params;
      const rows = await queryDB("SELECT id, deleted_at FROM entries WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Entry not found" });
      if (!rows[0].deleted_at) {
        return res.status(400).json({ error: "This entry must be deleted first before it can be permanently erased." });
      }

      await queryDB("DELETE FROM entries WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to permanently delete entry" });
    }
  });

  // Self Service -> Leave Balances & Leave Applications — kept in its own
  // file (LeaveRoutes.ts), same reasoning as profileRoutes.ts/holidayRoutes.ts/
  // Alerts.ts/UserManagement.ts/ConveyanceBillClaimRoutes.ts/AttendanceRoutes.ts
  // above.
  registerLeaveRoutes(app, {
    authenticateToken,
    queryDB,
    requireLeaveManager,
    hasLeaveManageAccess,
    getCurrentStepApprovers,
    createAlert,
    approveLeaveApplicationReliever,
    rejectLeaveApplicationReliever
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