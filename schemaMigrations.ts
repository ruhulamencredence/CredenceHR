/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ensureAccountBlockSchema } from "./AccountBlock";
import { ensureActiveUsersSchema } from "./ActiveUsersRoutes";
import { ensureAlertsSchema } from "./Alerts";
import { ensureAssetManagementSchema } from "./AssetManagementRoutes";
import { ensureBillClaimPolicySchema } from "./BillClaimPolicy";
import { ensureChatSchema } from "./ChatRoutes";
import { ensureCompanySchema } from "./CompanyRoutes";
import { ensureDeviceSchema } from "./DeviceRoutes";
import { ensureDocumentVaultSchema } from "./DocumentVaultRoutes";
import { ensureEmployeeTransferSchema } from "./EmployeeTransferRoutes";
import { ensureExitOffboardingSchema } from "./ExitOffboardingRoutes";
import { ensureGrievanceSchema } from "./GrievanceRoutes";
import { ensureHROperationsSchema } from "./HROperationsRoutes";
import { ensureEmployee360Schema } from "./HrOps360Routes";
import { ensureInfoRequestsSchema } from "./HrOpsInfoRequestsRoutes";
import { ensureHrReportsSchema } from "./HrOpsReportsRoutes";
import { ensureLoanRequestSchema } from "./LoanRequestRoutes";
import { ensureMobileBillSchema } from "./MobileBillRoutes";
import { ensurePayrollApprovalSchema } from "./PayrollApprovalRoutes";
import { ensurePayrollItemsSchema } from "./PayrollItemsRoutes";
import { ensurePayrollSchema } from "./PayrollRoutes";
import { ensurePerformanceSchema } from "./PerformanceRoutes";
import { ensureRecruitmentSchema } from "./RecruitmentRoutes";
import { ensureSiteAttendanceSchema } from "./SiteAttendanceRoutes";
import { ensureTaskSchema } from "./TaskRoutes";
import { ensureVehicleManagementSchema } from "./VehicleManagementRoutes";
import { ensureWebPushSchema } from "./WebPushService";
import { ensureHolidayCalendarSchema } from "./holidayRoutes";
import mysql from "mysql2/promise";

// Self-healing migrations for tables added AFTER the original schema.sql was written.
// Anyone who imported schema.sql before this table existed (an already-running,
// pre-existing database) would otherwise hit "Table doesn't exist" the first time this
// feature is used — CREATE TABLE IF NOT EXISTS here means a normal server restart is
// enough to pick it up, no manual SQL required.
export async function ensureSchemaMigrations(dbPool: mysql.Pool | null, deps: { EMPLOYEE_EXT_FIELD_DDL: any; getApprovalChain: any; queryDB: any }) {
  const { EMPLOYEE_EXT_FIELD_DDL, getApprovalChain, queryDB } = deps;
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
  // Final Submit of ONE Job (Jobs list -> Submit) — locks just that Job's
  // entries for that user; budget_submissions above still locks a whole Budget.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS job_submissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        job_id INT NOT NULL,
        budget_id INT NULL,
        user_id INT NOT NULL,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_job_user (job_id, user_id),
        KEY idx_job_submissions_budget (budget_id),
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure job_submissions table exists: " + err.message);
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
  await ensurePayrollApprovalSchema(dbPool);
  await ensureLoanRequestSchema(dbPool);
  // Payroll -> Allowance & Adjustment (PayrollItemsRoutes.ts) — after
  // ensurePayrollSchema, since its tables point at payrolls.
  await ensurePayrollItemsSchema(dbPool);

  // Asset Management (Employee Profile -> My Assets / New Requisition /
  // Requisition Status, plus Admin Panel -> Asset Management) — table +
  // schema owned by AssetManagementRoutes.ts, only the call site lives here,
  // same as every other self-healing migration in this function.
  await ensureAssetManagementSchema(dbPool);

  // Vehicle Requisition & Management (Self Service -> Book a Ride / Ride
  // Status, plus Admin Panel -> Vehicle Management) — table + schema owned
  // by VehicleManagementRoutes.ts, only the call site lives here.
  await ensureVehicleManagementSchema(dbPool);

  // Employee Transfer (Admin Panel -> Employees -> "Transfer / Change Role")
  // — table + schema owned by EmployeeTransferRoutes.ts, only the call site
  // lives here, same as every other self-healing migration in this function.
  await ensureEmployeeTransferSchema(dbPool);

  // World-class HRM extension modules — Exit/Offboarding, Performance
  // Management, Recruitment/ATS, Grievance & Disciplinary, Document Vault
  // (HR Analytics has no tables of its own, just aggregation queries over
  // these and existing tables) — each owns its schema in its own file, same
  // self-healing pattern as every migration above.
  await ensureExitOffboardingSchema(dbPool);
  await ensurePerformanceSchema(dbPool);
  await ensureRecruitmentSchema(dbPool);
  await ensureGrievanceSchema(dbPool);
  await ensureTaskSchema(dbPool);
  await ensureMobileBillSchema(dbPool);
  await ensureDocumentVaultSchema(dbPool);
  // HR Operations (personnel actions, letters, onboarding, service book) —
  // HROperationsRoutes.ts.
  await ensureHROperationsSchema(dbPool);
  await ensureEmployee360Schema(dbPool);
  await ensureHrReportsSchema(dbPool);
  await ensureInfoRequestsSchema(dbPool);
  await ensureSiteAttendanceSchema(dbPool);
  // Chat (Direct/Group/Community messaging) — table + schema owned by
  // ChatRoutes.ts, only the call site lives here, same as every other
  // self-healing migration in this function.
  await ensureChatSchema(dbPool);

  // Multi-company (CompanyRoutes.ts) — existing data becomes company 1. Runs
  // after every other table exists.
  await ensureCompanySchema(dbPool);

  // Mobile app device access (DeviceRoutes.ts).
  await ensureDeviceSchema(queryDB).catch((e: any) => console.warn("⚠️ Device access tables: " + e.message));
  await ensureActiveUsersSchema(queryDB).catch((e: any) => console.warn("⚠️ Active users table: " + e.message));

  // Desktop/browser notifications (WebPushService.ts).
  await ensureWebPushSchema(queryDB).catch((e: any) => console.warn("⚠️ Web push tables: " + e.message));

  // Bill Claim Policy: categories, rules and each claim's bill lines (BillClaimPolicy.ts).
  await ensureBillClaimPolicySchema(queryDB, (sql) => dbPool.query(sql)).catch((e: any) => console.warn("⚠️ Bill claim policy tables: " + e.message));

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

  // Permanent Delete Log — Superadmin-only audit trail of every entry ever
  // erased from the Job Recycle bin (DELETE /api/entries/:id/permanent, which
  // hard-deletes the entries row). No FK to entries on purpose: the row this
  // refers to is already gone by the time the log is read, so every
  // identifying field here is a plain snapshot taken right before that
  // DELETE, not a live join — see schema.sql's comment on this table.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS entry_permanent_delete_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        entry_id INT NOT NULL,
        entry_date DATE,
        job_name VARCHAR(30),
        job_no VARCHAR(100),
        project_name VARCHAR(150),
        mpr_no VARCHAR(100),
        item_name VARCHAR(255),
        requisitioned_qty DECIMAL(14,2),
        entry_created_by_name VARCHAR(100),
        entry_deleted_by_name VARCHAR(100),
        entry_deleted_at TIMESTAMP NULL,
        permanently_deleted_by INT NULL,
        permanently_deleted_by_name VARCHAR(100) NOT NULL,
        permanently_deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (permanently_deleted_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure entry_permanent_delete_log table exists: " + err.message);
  }

  // Delivery Date "minimum lead time" conditions — Admin Panel -> PEPM Manage
  // -> Data Import -> Condition Set (see deliveryDateConditions.ts's resolver
  // and EntriesRoutes.ts's enforcement). Two independent condition_types
  // ("entry" — New Job Entry/Add MPR, "job_edit" — changing an existing
  // entry's Delivery Date), each with one Global row (scope='global',
  // scope_id=0) plus any number of Project/Budget override rows. scope_id
  // is 0 (not NULL) for the Global row specifically so the unique key below
  // can actually enforce "only one Global row per condition_type" — MySQL
  // treats every NULL in a unique index as distinct from every other NULL,
  // which would silently allow duplicate Global rows otherwise.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS delivery_date_conditions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        condition_type ENUM('entry','job_edit') NOT NULL,
        scope ENUM('global','project','budget') NOT NULL DEFAULT 'global',
        scope_id INT NOT NULL DEFAULT 0,
        min_lead_days INT NOT NULL DEFAULT 0,
        apply_to_admins TINYINT(1) NOT NULL DEFAULT 0,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        updated_by INT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_delivery_condition (condition_type, scope, scope_id),
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    // Seed the two Global rows (disabled by default) so the resolver and the
    // Condition Set UI always have a row to read/upsert against instead of
    // needing separate "does a Global row exist yet" branches everywhere.
    await dbPool.query(
      `INSERT IGNORE INTO delivery_date_conditions (condition_type, scope, scope_id, min_lead_days, apply_to_admins, enabled) VALUES
       ('entry', 'global', 0, 0, 0, 0),
       ('job_edit', 'global', 0, 0, 0, 0)`
    );
  } catch (err: any) {
    console.warn("⚠️ Could not ensure delivery_date_conditions table exists: " + err.message);
  }

  // Per-Leave-Category Policy (Self Service -> Leave Manage -> "Leave
  // Policies") — see schema.sql's leave_category_policies comment for the
  // full design. Seeded with today's actual behavior (Reliever always
  // required, no other restriction) so an existing install's behavior never
  // silently changes on upgrade — a Leave Manager has to explicitly turn a
  // restriction on.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS leave_category_policies (
        id INT AUTO_INCREMENT PRIMARY KEY,
        category_key VARCHAR(100) NOT NULL,
        min_advance_notice_days INT NOT NULL DEFAULT 0,
        reliever_required TINYINT(1) NOT NULL DEFAULT 1,
        max_consecutive_days INT NULL DEFAULT NULL,
        require_paid_leave_exhausted TINYINT(1) NOT NULL DEFAULT 0,
        updated_by INT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_leave_category_policy (category_key),
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await dbPool.query(
      `INSERT IGNORE INTO leave_category_policies (category_key, min_advance_notice_days, reliever_required, max_consecutive_days, require_paid_leave_exhausted) VALUES
       ('casual', 0, 1, NULL, 0),
       ('sick', 0, 1, NULL, 0),
       ('without_pay', 0, 1, NULL, 0),
       ('custom_earn_leave', 0, 0, NULL, 0)`
    );
  } catch (err: any) {
    console.warn("⚠️ Could not ensure leave_category_policies table exists: " + err.message);
  }

  // Job Edit Approval queue — same self-healing pattern as entry_edit_history above.
  // See schema.sql's job_edit_requests comment for the full explanation.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS job_edit_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        -- NULL for a still-pending 'add_job' request — there's no real Job yet to
        -- point at, only what's proposed in payload; backfilled once approved.
        job_id INT NULL,
        entry_id INT NULL,
        action ENUM('add_item', 'delete_entry', 'add_job') NOT NULL,
        payload TEXT NULL,
        status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
        requested_by INT NOT NULL,
        reviewed_by INT NULL,
        reviewed_at TIMESTAMP NULL DEFAULT NULL,
        review_note VARCHAR(500) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE SET NULL,
        FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure job_edit_requests table exists: " + err.message);
  }

  // Job Edit's "Add New Job" — self-heal an existing job_edit_requests table (created
  // before 'add_job' existed) onto the new shape: job_id must become nullable (a
  // brand-new Job doesn't exist yet while its request is pending) and the action
  // ENUM needs the new 'add_job' member. Both MODIFY COLUMN calls are naturally
  // idempotent — safe to run on every startup, fresh installs included.
  try {
    await dbPool.query(`ALTER TABLE job_edit_requests MODIFY COLUMN job_id INT NULL`);
  } catch (err: any) {
    console.warn("⚠️ Could not make job_edit_requests.job_id nullable: " + err.message);
  }
  try {
    await dbPool.query(`ALTER TABLE job_edit_requests MODIFY COLUMN action ENUM('add_item', 'delete_entry', 'add_job') NOT NULL`);
  } catch (err: any) {
    console.warn("⚠️ Could not add 'add_job' to job_edit_requests.action: " + err.message);
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

  // GET /api/entries and /api/entries/mpr-usage both start with `WHERE
  // e.deleted_at IS NULL`, and a plain 'user' account (the majority of
  // accounts) additionally filters `AND e.created_by = ?` — created_by has
  // no FK (an entry's creator can be deleted without taking their entries
  // with them), so it was never indexed at all. Without this, every one of
  // those calls was a full table scan of `entries`, which only grows over
  // the life of the app and is hit on nearly every Dashboard open. Ignore
  // the error if it already exists (older MySQL has no
  // "CREATE INDEX IF NOT EXISTS").
  await dbPool
    .query(`CREATE INDEX idx_entries_deleted_created ON entries (deleted_at, created_by)`)
    .catch(() => {});

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
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add users.last_login_lat/lng/at columns: " + err.message);
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
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add users.can_view_login_location column: " + err.message);
  }
  try {
    // Superadmin-only grant, ONLY ever meaningful for role='admin': lets that Admin
    // ALSO set OTHER accounts' "Module Access" (Admin Panel -> Users -> Modules —
    // the admin_module_permissions rows GET/PUT /api/users/:id/module-permissions
    // manages) themselves, instead of every such grant needing the Superadmin.
    // Same on/off switch pattern as can_view_login_location above. Deliberately
    // narrower than that switch's own power, though: a delegated Admin using this
    // can only set Module Access for role='user' targets, never for another 'admin'
    // — promoting what an ADMIN can reach stays exclusively the Superadmin's call
    // (enforced server-side in UserManagement.ts's module-permissions handler, not
    // just hidden in the UI). OFF by default; a Superadmin always has this
    // implicitly and is never itself a valid target.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_grant_module_access TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add users.can_grant_module_access column: " + err.message);
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
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add users.can_access_user_panel column: " + err.message);
  }
  try {
    // Superadmin-only grant: lets an Admin or User account ALSO edit other
    // accounts' Leave balances on Self Service -> Leave Management (see the
    // leave_balances table below) — same on/off switch pattern as
    // can_access_user_panel above, but (unlike that one) applies to BOTH 'admin'
    // and 'user' roles. OFF by default; a Superadmin always has this implicitly.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_manage_leave TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add users.can_manage_leave column: " + err.message);
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
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add users.can_view_movement_claims/can_view_conveyance_claims columns: " + err.message);
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
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add users.can_view_budget_module column: " + err.message);
  }
  try {
    // Admin/Superadmin-granted per account (Admin Panel -> Users -> Leave):
    // shows the Leave Summary card on THIS account's own Dashboard. Always
    // true for role === 'superadmin'. OFF by default for 'admin'/'user' —
    // same toggle pattern as can_use_attendance/can_use_tracking above.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_view_leave_summary TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add users.can_view_leave_summary column: " + err.message);
  }
  try {
    // Superadmin-only grants: whether this Admin or User account can see/use
    // the Self Service -> Timesheet / Leave Application / My Leave sections at
    // all — same on/off pattern as can_view_movement_claims/can_view_
    // conveyance_claims above, applying to BOTH 'admin' and 'user' roles. OFF
    // by default; a Superadmin always has all three implicitly. Employee
    // Directory deliberately keeps NO such gate — every account can browse it
    // regardless of role or module access (see GlobalSidebar.tsx).
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_view_timesheet TINYINT(1) NOT NULL DEFAULT 0`);
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_view_leave_application TINYINT(1) NOT NULL DEFAULT 0`);
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_view_my_leave TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add users.can_view_timesheet/can_view_leave_application/can_view_my_leave columns: " + err.message);
  }
  // Admin Panel -> Users -> Block / Unblock (AccountBlock.ts).
  await ensureAccountBlockSchema(dbPool);
  try {
    // Chat audio/video calls (CallRoutes.ts) — a Self Service switch, OFF
    // until a Superadmin turns it on per account in Module Access.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_use_calls TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add users.can_use_calls column: " + err.message);
  }
  try {
    // Self Service -> My Tasks (TaskRoutes.ts) — OFF until turned on per
    // account in Module Access.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_view_tasks TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add users.can_view_tasks column: " + err.message);
  }
  try {
    // Self Service -> My Loan / Advance (LoanRequestRoutes.ts) — OFF until
    // turned on per account in Module Access.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_view_loan_request TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add users.can_view_loan_request column: " + err.message);
  }
  try {
    // Self Service -> My Letters & Service Record -> "Service Book" (the
    // employee's own read-only Employee 360, HrOps360Routes.ts) — OFF until
    // turned on per account in Module Access.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_view_service_book TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add users.can_view_service_book column: " + err.message);
  }
  try {
    // Self Service -> My Mobile SIM (MobileBillRoutes.ts) — OFF until turned
    // on per account in Module Access.
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_view_mobile_bill TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add users.can_view_mobile_bill column: " + err.message);
  }
  try {
    // Admin Dashboard "See all companies (group view)" — OFF until turned on
    // per account in Module Access (under Admin Dashboard).
    await dbPool.query(`ALTER TABLE users ADD COLUMN can_view_group_dashboard TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add users.can_view_group_dashboard column: " + err.message);
  }
  try {
    // Leave Application and "My Leave" became one page with one access
    // switch: an account that had either one has both (it could already open
    // the page, and now can also submit from it). Only touches rows where the
    // two differ, so it's a no-op on every restart after the first.
    await dbPool.query(
      `UPDATE users SET can_view_leave_application = 1, can_view_my_leave = 1
       WHERE can_view_leave_application <> can_view_my_leave`
    );
  } catch (err: any) {
    console.warn("⚠️ Could not merge Leave Application / My Leave access: " + err.message);
  }
  try {
    // Admin/Superadmin-granted per account (Admin Panel -> Users -> "Attend.
    // Project", right next to can_use_attendance): pins a 'user' OR 'admin'
    // account to exactly one Project for Remote Attendance. NULL by default
    // (unrestricted — same behavior as before this column existed). When set,
    // the account's own Attendance card only offers this one Project and the
    // server rejects check-in/check-out against any other one, even for
    // role='admin' (who is otherwise unrestricted on Projects). Never applies
    // to 'superadmin'. Nullable FK so a deleted Project just clears the pin
    // instead of blocking the delete or leaving a dangling id.
    await dbPool.query(`ALTER TABLE users ADD COLUMN attendance_project_id INT NULL`);
    await dbPool.query(
      `ALTER TABLE users ADD CONSTRAINT fk_users_attendance_project FOREIGN KEY (attendance_project_id) REFERENCES projects(id) ON DELETE SET NULL`
    );
  } catch (err: any) {
    // Column/constraint already exists — safe to ignore on every server restart after the first.
  }
  try {
    // Project location pin (Admin Panel -> Projects -> "Set Location on Map"), a
    // free OpenStreetMap/Leaflet picker — no paid maps API key required.
    await dbPool.query(`ALTER TABLE projects ADD COLUMN location_lat DECIMAL(10, 7) NULL`);
    await dbPool.query(`ALTER TABLE projects ADD COLUMN location_lng DECIMAL(10, 7) NULL`);
    await dbPool.query(`ALTER TABLE projects ADD COLUMN location_label VARCHAR(255) NULL`);
  } catch (err: any) {
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add projects.location_lat/lng/label columns: " + err.message);
  }
  try {
    // Optional site-radius circle (meters) drawn around the project's pin in the
    // map picker — e.g. to mark the approximate boundary of a site.
    await dbPool.query(`ALTER TABLE projects ADD COLUMN location_radius INT NULL`);
  } catch (err: any) {
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add projects.location_radius column: " + err.message);
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
  // Granular per-module action layers (Read Only/Edit-Add/Entry-Upload/
  // Delete-Trash/Permanent Delete — see PERMISSION_LAYERS in src/types.ts),
  // layered ON TOP of admin_module_permissions above: a row here is only
  // meaningful for an account that already has module_key granted there. Set
  // by the Superadmin (Admin Panel -> Users -> Module Access, shown once a
  // module listed in PERMISSION_LAYER_MODULES is checked). One row per
  // (user, module, layer) — a module with NO rows here for a given user
  // falls back to "every layer except permanent_delete" (see
  // requireModuleLayer() below), so granting the module alone keeps today's
  // full-access behavior, exactly like every other module not yet on this
  // system at all. Rolled out module by module, starting with 'departments'.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS admin_module_permission_layers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        module_key VARCHAR(50) NOT NULL,
        layer_key VARCHAR(30) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user_module_layer (user_id, module_key, layer_key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure admin_module_permission_layers table exists: " + err.message);
  }
  // Department-wise scoping for the 'attendance_reports' module only — set by
  // the Superadmin on top of admin_module_permissions (Admin Panel -> Users ->
  // Module Access -> "Attendance Report Departments", shown once
  // 'attendance_reports' itself is checked). A row here means the account may
  // ONLY see that one Department's rows on the Monthly Attendance Report /
  // Department filter / Date Wise report — GET /api/attendance/report/* in
  // AttendanceRoutes.ts filters on it via getAttendanceReportDeptScope()
  // below. No rows at all for a user (the common case — every existing grant
  // before this feature) means unrestricted, exactly like today: every
  // Department is visible. This is deliberately independent of whether the
  // account is a Department Supervisor (departments.supervisor_user_id) —
  // that's only used client-side to pre-tick a sensible default the first
  // time the modal opens; a non-Supervisor account can be scoped here too,
  // and a Supervisor can be left unscoped (full access) if the tick is
  // removed. Stores the plain-text Department name (not department_id) so it
  // reads the same way GET /api/attendance/report/departments and the
  // department query param on the report routes already do — see the mirror-
  // column comment there. PUT /api/departments/:id already re-writes
  // all_employees.department on a rename; the same rename also re-writes this
  // table's rows so a scoped grant doesn't silently go stale (see that route).
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS attendance_report_department_access (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        department VARCHAR(150) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user_department (user_id, department),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure attendance_report_department_access table exists: " + err.message);
  }
  // Department-wise scoping for the 'leave_applications' module only —
  // identical design to attendance_report_department_access above, just for
  // the "Monthly Leave Application" report (Admin Panel -> Users -> Module
  // Access -> "Leave Application Departments", shown once 'leave_applications'
  // itself is checked) instead of the Attendance Report. A row here means the
  // account may ONLY see Leave Applications from that one Department —
  // GET /api/leave-applications/report* in LeaveRoutes.ts filters on it via
  // getLeaveApplicationDeptScope() below. No rows at all for a user means
  // unrestricted (every Department visible). Independent of whether the
  // account is a Department Supervisor (departments.supervisor_user_id) —
  // that's only used client-side to pre-tick a sensible default the first
  // time the modal opens; a non-Supervisor account can be scoped here too,
  // and a Supervisor can be left unscoped (full access) if the tick is
  // removed. Stores the plain-text Department name (not department_id), same
  // as attendance_report_department_access, so a rename (PUT
  // /api/departments/:id) can re-write this table's rows too and keep a
  // scoped grant from silently going stale.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS leave_application_department_access (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        department VARCHAR(150) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user_department (user_id, department),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure leave_application_department_access table exists: " + err.message);
  }
  // Department-wise scoping for the 'conveyance' module only — identical
  // design to attendance_report_department_access/leave_application_
  // department_access above, just for the Admin Panel's "Conveyance Bill
  // Claim" tab (Admin Panel -> Users -> Module Access -> "Conveyance Claim
  // Departments", shown once 'conveyance' itself is checked). A row here
  // means the account may ONLY see Conveyance Bill Claims submitted by users
  // whose linked Employee Directory row has that one Department —
  // GET /api/user-claims in ConveyanceBillClaimRoutes.ts filters on it via
  // getConveyanceClaimDeptScope() below. No rows at all for a user means
  // unrestricted (every Department's claims visible), exactly like granting
  // the module alone. Same rename-sync convention as the other two tables —
  // see PUT /api/departments/:id in DepartmentsAndBranches.ts.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS conveyance_claim_department_access (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        department VARCHAR(150) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user_department (user_id, department),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure conveyance_claim_department_access table exists: " + err.message);
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
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn("⚠️ Could not add attendance.check_in_remarks/check_out_remarks columns: " + err.message);
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
  // What the phone itself says about location, sent with every heartbeat of the
  // APK's tracking (POST /api/tracking/state) — one row per user. Lets Employee
  // Tracking tell "Phone Location is OFF" / "permission removed" / "app closed"
  // / "standing still" apart, instead of only "no ping lately".
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS tracking_device_state (
        user_id INT PRIMARY KEY,
        location_on TINYINT(1) NULL,
        foreground_granted TINYINT(1) NULL,
        background_granted TINYINT(1) NULL,
        precise_granted TINYINT(1) NULL,
        mode VARCHAR(10) NULL,
        battery_pct INT NULL,
        reported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure tracking_device_state table exists: " + err.message);
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
    // Notices sent from Employee Tracking -> "Currently Not Tracked": one row
    // per recipient, with why they weren't tracked at that moment — the
    // month-end Tracking Notice Report reads these.
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS tracking_notice_recipients (
        id INT AUTO_INCREMENT PRIMARY KEY,
        notice_id INT NOT NULL,
        user_id INT NOT NULL,
        employee_pk INT NULL,
        reason VARCHAR(80) NULL,
        last_ping DATETIME NULL,
        sent_by INT NULL,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_tnr_sent (sent_at),
        INDEX idx_tnr_user (user_id),
        FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `).catch((e: any) => console.warn("⚠️ Could not ensure tracking_notice_recipients table exists: " + e.message));
    await dbPool.query(`ALTER TABLE notices ADD COLUMN source VARCHAR(30) NULL`).catch((e: any) => {
      if (e.code !== "ER_DUP_FIELDNAME") console.warn("⚠️ Could not add notices.source: " + e.message);
    });
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
  // Multi-account Payroll disbursement split (Admin Panel -> Employees ->
  // Edit -> Payment tab) — an Employee's Net Salary can be paid out split
  // across any number of Bank accounts and/or MFS (bKash/Nagad/Rocket)
  // accounts, each carrying a percentage of Net Salary rather than a single
  // account. No row here at all (the common case) means unchanged legacy
  // behavior — Run Payroll's single global Payment Method dropdown decides
  // how that employee gets paid, exactly as before this feature existed.
  // percentage is validated at the API layer to sum to at most 100 across an
  // employee's active rows, not enforced by the DB — same reasoning as
  // approval_templates.is_default's "at most one default" comment above.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS employee_payment_accounts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        account_type ENUM('bank', 'mfs') NOT NULL DEFAULT 'bank',
        account_label VARCHAR(100) NOT NULL,
        bank_name VARCHAR(150) NULL,
        branch_name VARCHAR(150) NULL,
        provider VARCHAR(50) NULL,
        account_number VARCHAR(100) NOT NULL,
        percentage DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure employee_payment_accounts table exists: " + err.message);
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
  // Branches (Admin Panel -> Branches, its own AdminModuleKey/module
  // permission — see DepartmentsAndBranches.ts) — a GPS-pinned site, kept
  // separate from Projects since Projects also back MPR Entries, Bulk Add
  // Users logins and Budget/Job reports. This table's own CREATE TABLE lived
  // only in schema.sql (a static reference file, not auto-run) until now —
  // no self-healing migration ever created it for a database that was
  // bootstrapped purely from this file's own migrations, which would leave
  // DepartmentsAndBranches.ts's /api/branches routes erroring against a
  // table that never existed. Matches schema.sql's definition, plus
  // branch_type below (new).
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS branches (
        id INT AUTO_INCREMENT PRIMARY KEY,
        branch_name VARCHAR(150) UNIQUE NOT NULL,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        location_lat DECIMAL(10, 7) NULL,
        location_lng DECIMAL(10, 7) NULL,
        location_label VARCHAR(255) NULL,
        location_radius INT NULL,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure branches table exists: " + err.message);
  }
  // branch_type — which Holiday Calendar (Admin Panel -> Holidays) applies to
  // every Employee at this Branch: 'head_office' or 'project_site'. Added
  // after the table itself so ER_DUP_FIELDNAME below just means "already
  // has it" on a database that already had `branches` (from schema.sql)
  // before this column existed. Defaults to 'project_site' — the old,
  // single, undifferentiated calendar's dates get copied into BOTH groups
  // (see the holiday_calendar migration further down), so which default a
  // not-yet-classified Branch gets doesn't silently lose anyone's holidays;
  // an Admin can reclassify any Branch afterwards.
  try {
    await dbPool.query(`ALTER TABLE branches ADD COLUMN branch_type ENUM('head_office', 'project_site') NOT NULL DEFAULT 'project_site'`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add branches.branch_type column: " + err.message);
    }
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
  // Who filed the claim when it isn't the claimant themself — an Admin with
  // Conveyance -> "Claim on Behalf" (POST /api/user-claims/on-behalf/:userId).
  // NULL for a claim the employee filed on their own.
  try {
    await dbPool.query(`ALTER TABLE user_claims ADD COLUMN filed_by INT NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add user_claims.filed_by column: " + err.message);
    }
  }
  // Editing a claim before it is locked (ConveyanceBillClaimRoutes.ts):
  //   first_submitted_at  the date window ("bills for the last N days") is
  //                       counted from here, so a returned claim fixed days
  //                       later still accepts its own dates
  //   version             +1 on every edit; an approver's Approve/Return/Reject
  //                       carries the version they looked at, so nothing is
  //                       approved that they haven't seen
  //   edit_state          'returned' while sent back to the employee
  //   return_reason       the approver's reason for the Return
  //   reclaim_allowed     Rejected, but the approver ticked "allow re-claim":
  //                       the employee may edit and resubmit it
  for (const [col, ddl] of [
    ["first_submitted_at", "DATETIME NULL"],
    ["version", "INT NOT NULL DEFAULT 1"],
    ["edit_state", "VARCHAR(20) NULL"],
    ["return_reason", "TEXT NULL"],
    ["reclaim_allowed", "TINYINT(1) NOT NULL DEFAULT 0"]
  ] as const) {
    try {
      await dbPool.query(`ALTER TABLE user_claims ADD COLUMN ${col} ${ddl}`);
      if (col === "first_submitted_at") await dbPool.query(`UPDATE user_claims SET first_submitted_at = created_at WHERE first_submitted_at IS NULL`);
    } catch (err: any) {
      if (err.code !== "ER_DUP_FIELDNAME") console.warn(`⚠️ Could not add user_claims.${col} column: ` + err.message);
    }
  }
  // Every submit / edit / return / reject / resubmit of a Conveyance Bill
  // Claim, with the claim as it stood afterwards (snapshot_json) — what the
  // approvers' "changed since you last saw it" is worked out from.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS user_claim_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_claim_id INT NOT NULL,
        action VARCHAR(20) NOT NULL,
        actor_id INT NULL,
        actor_name VARCHAR(255) NULL,
        reason TEXT NULL,
        version INT NOT NULL DEFAULT 1,
        snapshot_json MEDIUMTEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_uch_claim (user_claim_id),
        FOREIGN KEY (user_claim_id) REFERENCES user_claims(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure user_claim_history table: " + err.message);
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
    // Attendance Correction / Asset Requisition requests routed through this same Approval Workflow engine.
    await dbPool.query(`
      ALTER TABLE approval_requests
        MODIFY COLUMN source_type ENUM('attendance','claim','user_claim','attendance_correction','leave_application','asset_requisition','vehicle_requisition','mobile_limit_request','advance_request') NOT NULL,
        MODIFY COLUMN event_type ENUM('check_in','check_out','submit') NOT NULL
    `);
    // 'returned': a Conveyance Bill Claim sent back to the employee to fix
    // (it leaves every queue until they resubmit; the chain then restarts at
    // Layer 1). Only user_claim requests use it.
    await dbPool.query(`ALTER TABLE approval_requests MODIFY COLUMN status ENUM('pending','approved','rejected','returned') NOT NULL DEFAULT 'pending'`);
    // GET /api/my-approvals (PendingApprovalsCard — hit on every Dashboard
    // open, by every account) starts with `WHERE status = 'pending'`, which
    // was an unindexed full table scan of every approval request ever
    // created. Ignore the error if it already exists.
    await dbPool.query(`CREATE INDEX idx_approval_requests_status ON approval_requests (status)`).catch(() => {});
    // The Monthly Attendance Report (and the Admin Dashboard that reads it)
    // reads one month by date; claims and leave are read from a date on.
    await dbPool.query(`CREATE INDEX idx_attendance_date ON attendance (attendance_date)`).catch(() => {});
    await dbPool.query(`CREATE INDEX idx_user_claims_claim_date ON user_claims (claim_date)`).catch(() => {});
    await dbPool.query(`CREATE INDEX idx_leave_applications_end_date ON leave_applications (end_date)`).catch(() => {});
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
  // Approver Type override (Template editor's "Layer 1" card) — when a
  // Template is built with its first Layer explicitly set to something other
  // than the default virtual "Supervisor" position (i.e. an Employee or Admin
  // picked by hand), skip_auto_supervisor is set true so
  // createTemplateApprovalRequest skips resolveSupervisorApprover entirely
  // and that Template's own step_order 1 becomes the request's real first
  // step. Defaults to 0/false for every existing template, so this is a
  // zero-behavior-change addition until a Superadmin opts a template into it.
  try {
    await dbPool.query(`ALTER TABLE approval_templates ADD COLUMN skip_auto_supervisor TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add approval_templates.skip_auto_supervisor column: " + err.message);
    }
  }
  // Per-step Approver Type — 'employee' (the existing pick-any-user behavior,
  // unchanged) or 'admin' (the same picker, filtered to Admin/Superadmin
  // accounts). Purely a UI label/filter on top of the existing
  // approval_template_step_approvers mechanism; defaults to 'employee' so
  // every pre-existing step keeps behaving exactly as before.
  try {
    await dbPool.query(`ALTER TABLE approval_template_steps ADD COLUMN approver_type ENUM('employee','admin') NOT NULL DEFAULT 'employee'`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add approval_template_steps.approver_type column: " + err.message);
    }
  }
  // Widen approver_type for 'vehicle_maintainer' — a Vehicle Requisition
  // template's FINAL Layer can be handed to whoever holds the
  // 'vehicle_maintainer' module grant instead of a plain employee/admin
  // approver. Reaching that Layer skips the separate Approve step entirely:
  // the Vehicle Maintainer's own vehicle+driver Assign action (see PUT
  // .../approve-and-assign in VehicleManagementRoutes.ts) both closes the
  // approval chain and confirms the ride in one action, since their job at
  // that point is only to hand over a vehicle, not to review the request.
  try {
    // 'asset_fulfiller' is the Asset Requisition equivalent: an 'asset'
    // Template's FINAL Layer whose approver fulfills/hands over the items
    // (typing what was handed over) instead of approving — see PUT
    // /api/assets/requisitions/:id/approve-and-fulfill in AssetManagementRoutes.ts.
    await dbPool.query(`ALTER TABLE approval_template_steps MODIFY COLUMN approver_type ENUM('employee','admin','vehicle_maintainer','asset_fulfiller','conveyance_disburser') NOT NULL DEFAULT 'employee'`);
  } catch (err: any) {
    console.warn("⚠️ Could not widen approval_template_steps.approver_type to include 'vehicle_maintainer': " + err.message);
  }
  // Custom per-step Layer name (Template editor) — NULL means "use the
  // generic/position-based name" (ApprovalTemplateManager.tsx's LAYER_NAMES,
  // e.g. Asset Requisition's Layer 3 = "Inventory/Store Disbursement"). That
  // position-based fallback is exactly right for a template built in the
  // original fixed order, but once a Superadmin freely drags Layers around
  // (adding one, or moving an existing one like Inventory earlier), the
  // label needs to travel WITH the step's own approvers instead of jumping
  // to whichever generic name that position happens to carry — this column
  // lets a Layer keep its intended identity across any reorder.
  try {
    await dbPool.query(`ALTER TABLE approval_template_steps ADD COLUMN label VARCHAR(100) NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add approval_template_steps.label column: " + err.message);
    }
  }
  // Widen request_type to add 'asset' (Asset Requisition, routed through this
  // same Dynamic Approval Engine — see createTemplateApprovalRequest) onto
  // the original ENUM('conveyance','leave','timesheet'). MODIFY COLUMN is
  // safe to re-run every startup (no-op once already widened), unlike ADD
  // COLUMN's ER_DUP_FIELDNAME pattern above.
  try {
    await dbPool.query(`ALTER TABLE approval_templates MODIFY COLUMN request_type ENUM('conveyance','leave','timesheet','asset') NOT NULL`);
    await dbPool.query(`ALTER TABLE employee_template_assignments MODIFY COLUMN request_type ENUM('conveyance','leave','timesheet','asset') NOT NULL`);
  } catch (err: any) {
    console.warn("⚠️ Could not widen request_type ENUM to include 'asset': " + err.message);
  }
  // Widen request_type to add 'vehicle' (Vehicle Requisition, routed through
  // this same Dynamic Approval Engine — see the Vehicle Requisition
  // Flowchart's single "HR/Admin Review" layer, LAYER_NAMES in
  // ApprovalTemplateManager.tsx).
  try {
    await dbPool.query(`ALTER TABLE approval_templates MODIFY COLUMN request_type ENUM('conveyance','leave','timesheet','asset','vehicle') NOT NULL`);
    await dbPool.query(`ALTER TABLE employee_template_assignments MODIFY COLUMN request_type ENUM('conveyance','leave','timesheet','asset','vehicle') NOT NULL`);
  } catch (err: any) {
    console.warn("⚠️ Could not widen request_type ENUM to include 'vehicle': " + err.message);
  }
  // 'mobile' — Mobile Bill limit raise requests (MobileBillRoutes.ts).
  try {
    await dbPool.query(`ALTER TABLE approval_templates MODIFY COLUMN request_type ENUM('conveyance','leave','timesheet','asset','vehicle','mobile') NOT NULL`);
    await dbPool.query(`ALTER TABLE employee_template_assignments MODIFY COLUMN request_type ENUM('conveyance','leave','timesheet','asset','vehicle','mobile') NOT NULL`);
  } catch (err: any) {
    console.warn("⚠️ Could not widen request_type ENUM to include 'mobile': " + err.message);
  }
  // 'loan' — Self Service loan / salary advance requests (LoanRequestRoutes.ts).
  try {
    await dbPool.query(`ALTER TABLE approval_templates MODIFY COLUMN request_type ENUM('conveyance','leave','timesheet','asset','vehicle','mobile','loan') NOT NULL`);
    await dbPool.query(`ALTER TABLE employee_template_assignments MODIFY COLUMN request_type ENUM('conveyance','leave','timesheet','asset','vehicle','mobile','loan') NOT NULL`);
  } catch (err: any) {
    console.warn("⚠️ Could not widen request_type ENUM to include 'loan': " + err.message);
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
  // Custom Leave Categories (Leave Manage -> Set Balance in Bulk -> Add
  // Category) — see schema.sql's comment on leave_categories for the design.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS leave_categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        category_key VARCHAR(100) NOT NULL,
        label VARCHAR(100) NOT NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_leave_category_key (category_key),
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure leave_categories table exists: " + err.message);
  }
  // Earn Leave (accrual leave) didn't exist as a category at all before, so
  // no account could ever apply for it and Leave Policies had nothing to
  // configure for it. Seeded once as an ordinary Custom Leave Category (same
  // row shape "Add Category" in the bulk panel would create) so it gets the
  // whole existing pipeline — Set Balance in Bulk, Leave Policies, Leave
  // Application submission — for free, with no separate code path. Balance
  // itself is NOT auto-accrued here; a Leave Manager sets it via Set Balance
  // in Bulk or a Leave Balance Workflow (see leave_balance_workflows below)
  // same as any other category.
  try {
    await dbPool.query(
      `INSERT IGNORE INTO leave_categories (category_key, label, created_by) VALUES ('custom_earn_leave', 'Earn Leave', NULL)`
    );
  } catch (err: any) {
    console.warn("⚠️ Could not seed the Earn Leave category: " + err.message);
  }
  // Per-account balance for each Custom Leave Category above — the dynamic
  // equivalent of leave_balances' fixed three columns.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS leave_category_balances (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        category_id INT NOT NULL,
        balance DECIMAL(5, 1) NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user_category (user_id, category_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (category_id) REFERENCES leave_categories(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure leave_category_balances table exists: " + err.message);
  }
  // Leave Manage -> "Year Settings" — a single row (id=1) holding the
  // recurring HR Leave Year close/start dates (MM-DD, no year component —
  // the same close/start date applies every year) and whether the year
  // should roll over automatically. start_month_day is normally just the day
  // after close_month_day (suggested client-side), but stored separately
  // since an admin can still override it. See checkAndRunLeaveYearRollover in
  // LeaveRoutes.ts for what "auto_rollover" actually does once the start
  // date arrives — applies every active Leave Balance Workflow below to
  // every account, same as clicking "Apply Now" by hand.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS leave_year_settings (
        id INT PRIMARY KEY DEFAULT 1,
        close_month_day VARCHAR(5) NOT NULL DEFAULT '12-31',
        start_month_day VARCHAR(5) NOT NULL DEFAULT '01-01',
        auto_rollover TINYINT(1) NOT NULL DEFAULT 0,
        last_rollover_year INT NULL,
        updated_by INT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await dbPool.query(
      `INSERT IGNORE INTO leave_year_settings (id, close_month_day, start_month_day, auto_rollover) VALUES (1, '12-31', '01-01', 0)`
    );
  } catch (err: any) {
    console.warn("⚠️ Could not ensure leave_year_settings table exists: " + err.message);
  }
  // Leave Manage -> "Leave Balance Workflows" — a named set of per-category
  // annual balances, applied to accounts either Globally ("General", scope_type
  // 'general', exactly one such row — seeded below, id=1, can never be
  // deleted) or to every account whose Employee Directory row has a matching
  // Designation (scope_type 'designation', e.g. "Manager", "GM"). Applying
  // (POST /api/leave-balance-workflows/apply, or the year-end auto-rollover
  // above) runs General first, then each active Designation workflow, so a
  // Designation-specific balance for a category overrides the General one
  // for just that category, for just accounts with that Designation — any
  // category the Designation workflow doesn't mention keeps its General
  // value. See leave_balance_workflow_items below for the per-category
  // amounts themselves.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS leave_balance_workflows (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        scope_type ENUM('general', 'designation') NOT NULL DEFAULT 'designation',
        designation VARCHAR(255) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await dbPool.query(
      `INSERT IGNORE INTO leave_balance_workflows (id, name, scope_type, designation, is_active) VALUES (1, 'General', 'general', NULL, 1)`
    );
  } catch (err: any) {
    console.warn("⚠️ Could not ensure leave_balance_workflows table exists: " + err.message);
  }
  // Per-Leave-Category balance amount within a Leave Balance Workflow above.
  // category_key matches "Set Balance in Bulk"'s own key naming — the 3 fixed
  // 'casual_leave'/'sick_leave'/'leave_without_pay' balance-column names, or a
  // custom category's leave_categories.category_key (e.g. 'custom_earn_leave').
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS leave_balance_workflow_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        workflow_id INT NOT NULL,
        category_key VARCHAR(100) NOT NULL,
        balance_days DECIMAL(5, 1) NOT NULL DEFAULT 0,
        UNIQUE KEY uniq_workflow_category (workflow_id, category_key),
        FOREIGN KEY (workflow_id) REFERENCES leave_balance_workflows(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure leave_balance_workflow_items table exists: " + err.message);
  }
  // Self Service -> Leave Application — one row per submitted application.
  // Submitting one immediately deducts day_count from the matching
  // leave_balances column (see POST /api/leave-applications below).
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS leave_applications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        leave_type VARCHAR(64) NOT NULL,
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
  // Custom Leave Categories in Leave Type (see leave_categories/
  // leave_category_balances above) — leave_type used to be a hardcoded
  // ENUM('casual', 'sick', 'without_pay'), which made it impossible to submit
  // a Leave Application against a custom category (only its balance could be
  // set, never spent). Widened to VARCHAR so it can also hold a Leave
  // Category's category_key (e.g. "custom_maternity_leave") — see
  // isValidLeaveType/getLeaveTypeLabel/getLeaveTypeBalance/
  // adjustLeaveTypeBalance below for how both kinds of value are handled from
  // here on. MODIFY COLUMN is naturally idempotent — safe to run on every
  // startup, unlike an ADD COLUMN, and a fresh install already gets VARCHAR(64)
  // from the CREATE TABLE above so this is a no-op there.
  try {
    await dbPool.query(`ALTER TABLE leave_applications MODIFY COLUMN leave_type VARCHAR(64) NOT NULL`);
  } catch (err: any) {
    console.warn("⚠️ Could not widen leave_applications.leave_type to VARCHAR: " + err.message);
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
  // GET /api/my-approvals (PendingApprovalsCard) looks up a Reliever's
  // still-pending queue with `WHERE reliever_id = ? AND reliever_status =
  // 'pending' AND status = 'pending'` — without this, that's a full scan of
  // every Leave Application ever filed, on every Dashboard open. Ignore the
  // error if it already exists.
  await dbPool
    .query(`CREATE INDEX idx_leave_applications_reliever ON leave_applications (reliever_id, reliever_status, status)`)
    .catch(() => {});

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

  // Links an Employee Directory row to its structured Branch (above) — same
  // "self-healing FK column" pattern as department_id just above, and the
  // same reason it's needed: which Holiday Calendar (head_office vs
  // project_site) applies to this Employee is driven entirely by their
  // Branch's branch_type (see getEmployeeBranchTypeMap in holidayRoutes.ts),
  // so every Employee needs a real link to a Branch row, not just the old
  // free-text all_employees.branch string.
  try {
    await dbPool.query(`ALTER TABLE all_employees ADD COLUMN branch_id INT NULL`);
    await dbPool.query(`ALTER TABLE all_employees ADD FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME" && err.code !== "ER_DUP_KEYNAME" && err.code !== "ER_FK_DUP_NAME") {
      console.warn("⚠️ Could not add all_employees.branch_id column: " + err.message);
    }
  }

  // One-time-per-value migration: seed `branches` from any distinct legacy
  // free-text all_employees.branch values that don't have a matching Branch
  // row yet, then backfill branch_id for every directory row still missing
  // it — same shape as the department_id backfill above. A branch created
  // this way (rather than explicitly in Admin Panel -> Branches) has no GPS
  // pin yet and defaults to branch_type='project_site' (the column default);
  // an Admin can reclassify it or add a location afterwards.
  try {
    await dbPool.query(`
      INSERT INTO branches (branch_name)
      SELECT DISTINCT TRIM(e.branch) FROM all_employees e
      WHERE e.branch IS NOT NULL AND TRIM(e.branch) <> ''
        AND NOT EXISTS (SELECT 1 FROM branches b WHERE b.branch_name = TRIM(e.branch))
    `);
    await dbPool.query(`
      UPDATE all_employees e
      JOIN branches b ON b.branch_name = TRIM(e.branch)
      SET e.branch_id = b.id
      WHERE e.branch_id IS NULL AND e.branch IS NOT NULL AND TRIM(e.branch) <> ''
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not migrate free-text all_employees.branch values into the branches table: " + err.message);
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
