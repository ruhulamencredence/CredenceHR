-- MPR Tracker Database Schema & Seed Data
-- Import this SQL file into XAMPP MySQL / phpMyAdmin

CREATE DATABASE IF NOT EXISTS mpr_tracker_db;
USE mpr_tracker_db;

-- Users Table
-- email: NULL for bulk-created (Project Name + Password) users, which have no email.
-- username: the login ID for bulk-created users — the Project Name with all spaces
-- stripped and lowercased. Regular (Admin-created single) users leave this NULL and
-- keep logging in with email + password.
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NULL,
  username VARCHAR(150) UNIQUE NULL,
  password_hash VARCHAR(255) NOT NULL,
  -- 'superadmin' is the single top-level account (seeded from .env — see
  -- seedAdminFromEnv in server.ts). Only a Superadmin can promote/demote a User
  -- <-> Admin and control which Admin Panel modules each Admin can access
  -- (see admin_module_permissions below). A superadmin cannot be created through
  -- the API — only via the .env bootstrap.
  role ENUM('superadmin','admin','user') DEFAULT 'user',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Captured from the device's location permission at login time (mandatory —
  -- login is blocked client-side if the user declines). Only the MOST RECENT
  -- login's coordinates are kept (overwritten on every login), not a history.
  last_login_lat DECIMAL(10, 7) NULL,
  last_login_lng DECIMAL(10, 7) NULL,
  last_login_at TIMESTAMP NULL,
  -- Feature permissions the Admin can toggle per user (Admin Panel -> Users).
  -- can_edit_delivery_date: lets the user edit Delivery Date after Submit, and even
  -- after Final Submit (every other field stays locked either way). ON by default.
  -- can_job_edit: unlocks the "Job Edit" section on the User Page, letting the user
  -- add/edit/delete MPR entries inside an already Final-Submitted Job. OFF by default.
  -- can_use_attendance: shows the Remote Attendance Check In/Out card on the user's
  -- own Dashboard at all (separate from the "attendance" Admin Panel module, which
  -- is about reviewing everyone ELSE's records). OFF by default.
  can_edit_delivery_date TINYINT(1) NOT NULL DEFAULT 1,
  can_job_edit TINYINT(1) NOT NULL DEFAULT 0,
  can_use_attendance TINYINT(1) NOT NULL DEFAULT 0,
  -- can_use_tracking: lets this account's APK send background location pings for
  -- Employee Tracking (Admin Panel -> Employee Tracking module). OFF by default —
  -- separate from the "tracking" AdminModuleKey, which is about VIEWING everyone's
  -- live location, not this account's own device reporting its position.
  can_use_tracking TINYINT(1) NOT NULL DEFAULT 0,
  -- Superadmin-only grant: lets a plain Admin see the "Last Login Location" column
  -- in Admin Panel -> Users (Admin Panel -> Users -> per-Admin "Location Access"
  -- toggle). OFF by default — a Superadmin always sees it regardless of this flag;
  -- a plain Admin sees it ONLY if the Superadmin has explicitly switched this on
  -- for their account. Meaningless for role='user' rows.
  can_view_login_location TINYINT(1) NOT NULL DEFAULT 0,
  -- Superadmin-only grant, only ever meaningful for role='admin': lets that Admin
  -- ALSO set OTHER accounts' Module Access (Admin Panel -> Users -> Modules —
  -- admin_module_permissions rows) themselves, instead of every such grant
  -- needing the Superadmin (Admin Panel -> Users -> per-Admin "Grants Modules"
  -- toggle, same on/off pattern as can_view_login_location above). OFF by
  -- default. Deliberately narrower than the Superadmin's own version of this
  -- power: a delegated Admin using it can only grant/revoke Module Access for a
  -- role='user' target, never another 'admin' — enforced server-side in
  -- UserManagement.ts, not just hidden in the UI.
  can_grant_module_access TINYINT(1) NOT NULL DEFAULT 0,
  -- Superadmin-only grant: lets a plain Admin ALSO use the User Panel (mark Remote
  -- Attendance, submit Claims/Conveyance Bills, enter Job/MPR data) alongside their
  -- normal Admin Panel (Admin Panel -> Users -> per-Admin "User Panel Access"
  -- toggle, same on/off pattern as can_view_login_location above). OFF by default;
  -- meaningless for role='user' (already has it by definition) and role='superadmin'.
  can_access_user_panel TINYINT(1) NOT NULL DEFAULT 0,
  -- Superadmin-only grant: lets this Admin or User account edit OTHER users'
  -- Leave balances on the Self Service -> Leave Management page (see
  -- leave_balances below). OFF by default; a Superadmin always has this
  -- implicitly. PUT /api/users/:id/leave-management-access.
  can_manage_leave TINYINT(1) NOT NULL DEFAULT 0,
  -- Superadmin-only grants: whether this Admin or User account can see/use the
  -- Movement Claim (GPS Check In/Out) and Conveyance Bill Claim sections on
  -- their own User Panel at all, same on/off pattern as can_manage_leave above
  -- and gated the same way every other module in this app is (nothing visible
  -- without an explicit Superadmin grant). OFF by default; a Superadmin always
  -- has both implicitly. PUT /api/users/:id/movement-claim-access and
  -- PUT /api/users/:id/conveyance-claim-access.
  can_view_movement_claims TINYINT(1) NOT NULL DEFAULT 0,
  can_view_conveyance_claims TINYINT(1) NOT NULL DEFAULT 0
);

-- Projects Table
CREATE TABLE IF NOT EXISTS projects (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_name VARCHAR(150) UNIQUE NOT NULL,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Site location pin, set from Admin Panel -> Projects -> "Set Location on Map"
  -- (free OpenStreetMap/Leaflet picker — no paid maps API key needed). All three
  -- are NULL until an Admin/Superadmin marks a spot for this project.
  location_lat DECIMAL(10, 7) NULL,
  location_lng DECIMAL(10, 7) NULL,
  location_label VARCHAR(255) NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Branches Table (Admin Panel -> Branches — separate from Projects; Projects
-- also back MPR Entries, Bulk Add Users logins and Budget/Job reports, so
-- Branch rows are kept in their own table rather than mixed into `projects`.
-- Phase 1: Branch management only — nothing else reads from this table yet.)
CREATE TABLE IF NOT EXISTS branches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  branch_name VARCHAR(150) UNIQUE NOT NULL,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Site location pin, set from Admin Panel -> Branches -> "Set Location on Map"
  -- (same free OpenStreetMap/Leaflet picker Projects uses). All three are NULL
  -- until an Admin/Superadmin marks a spot for this branch.
  location_lat DECIMAL(10, 7) NULL,
  location_lng DECIMAL(10, 7) NULL,
  location_label VARCHAR(255) NULL,
  location_radius INT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- MPR Numbers Table
CREATE TABLE IF NOT EXISTS mpr_numbers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  mpr_no VARCHAR(100) UNIQUE NOT NULL,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Jobs Table (Job No + Unique Job Duration)
-- job_no is scoped PER USER PER BUDGET (created_by, budget_id) instead of system-wide,
-- so every user's own submissions start again from JOB-0001 independently of everyone
-- else's, AND start again from JOB-0001 whenever they switch to a different Budget —
-- see the unique key below (created_by, budget_id, job_no).
CREATE TABLE IF NOT EXISTS jobs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  job_no VARCHAR(100) NOT NULL,
  job_duration VARCHAR(50) NOT NULL,
  created_by INT NULL,
  budget_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_budget_job_no (created_by, budget_id, job_no),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE SET NULL
);

-- User-Project Permissions Table (Admin controls which User can access which Project)
CREATE TABLE IF NOT EXISTS user_project_permissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  project_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_project (user_id, project_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Admin Module Permissions Table (Superadmin controls which Admin Panel modules
-- ('projects','mprs','imports','reports','users','recycle','editlog') each Admin
-- account may access. Only meaningful for role='admin' rows; a Superadmin always
-- has every module implicitly and a plain 'user' never reaches the Admin Panel.
-- An Admin with no rows here has NO module access until the Superadmin grants some.
CREATE TABLE IF NOT EXISTS admin_module_permissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  module_key VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_module (user_id, module_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Leave Balances Table (Self Service -> Leave Management). One row per Admin/User
-- account holding how many days of each leave type they currently have left. Only
-- the Superadmin, and any Admin/User the Superadmin has granted can_manage_leave
-- (see users above), can edit another account's row here — see
-- PUT /api/leave-balances/:userId. A missing row simply means 0 for all three
-- (created on first save, not at user-creation time).
CREATE TABLE IF NOT EXISTS leave_balances (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  casual_leave DECIMAL(5, 1) NOT NULL DEFAULT 0,
  sick_leave DECIMAL(5, 1) NOT NULL DEFAULT 0,
  leave_without_pay DECIMAL(5, 1) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_leave (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Custom Leave Categories (Self Service -> Leave Manage -> "Set Balance in
-- Bulk" -> "Add Category"). Lets a Leave Manager define extra leave types on
-- the fly (e.g. "Maternity Leave", "Earned Leave") beyond the fixed
-- Casual/Sick/Leave-without-Pay columns on leave_balances above, without a
-- schema change per new type. category_key is the stable slug the frontend
-- and API key balances by (e.g. "custom_maternity_leave"); label is what's
-- shown on screen. See POST /api/leave-categories and PUT
-- /api/leave-balances/bulk's custom_categories handling in LeaveRoutes.ts.
CREATE TABLE IF NOT EXISTS leave_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  category_key VARCHAR(100) NOT NULL,
  label VARCHAR(100) NOT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_leave_category_key (category_key),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- One row per Admin/User account per custom Leave Category above — the
-- dynamic-category equivalent of leave_balances' fixed casual_leave/
-- sick_leave/leave_without_pay columns. A missing row simply means 0, same
-- convention as leave_balances. No usage-deduction tracking yet (unlike the
-- three fixed types via leave_applications) — Set Balance in Bulk just
-- overwrites this directly.
CREATE TABLE IF NOT EXISTS leave_category_balances (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  category_id INT NOT NULL,
  balance DECIMAL(5, 1) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_category (user_id, category_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES leave_categories(id) ON DELETE CASCADE
);

-- Per-Leave-Category Policy (Self Service -> Leave Manage -> "Leave
-- Policies"). One row per Leave Type — the 3 fixed types (category_key
-- 'casual', 'sick', 'without_pay', matching leave_applications.leave_type
-- exactly) plus any custom Leave Category (category_key = its leave_categories.
-- category_key, e.g. "custom_maternity_leave"). A missing row for a custom
-- category means "no restrictions" (defaults below). Enforced server-side in
-- POST /api/leave-applications (LeaveRoutes.ts) — never just a UI hint.
CREATE TABLE IF NOT EXISTS leave_category_policies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  category_key VARCHAR(100) NOT NULL,
  -- Must apply at least this many days before the Leave's Start Date. 0 = no
  -- restriction (same-day/retrospective apply allowed, e.g. Sick Leave).
  min_advance_notice_days INT NOT NULL DEFAULT 0,
  -- Whether a Reliever must be picked for this Leave Type. When off, the
  -- application skips the Reliever step entirely and goes straight into the
  -- Dynamic Approval Engine, same as if a Reliever had just approved it.
  reliever_required TINYINT(1) NOT NULL DEFAULT 1,
  -- Longest single application allowed for this Leave Type, in days. NULL =
  -- no cap.
  max_consecutive_days INT NULL DEFAULT NULL,
  -- Leave Without Pay style rule: this Leave Type may only be applied for once
  -- the account's Casual Leave AND Sick Leave balances are both exhausted (0).
  require_paid_leave_exhausted TINYINT(1) NOT NULL DEFAULT 0,
  updated_by INT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_leave_category_policy (category_key),
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Seed the 3 fixed Leave Types with today's actual behavior (Reliever always
-- required, no advance-notice/consecutive-day/exhaustion rule) so turning a
-- restriction ON is always an explicit Leave Manager action, never a silent
-- behavior change on upgrade.
INSERT IGNORE INTO leave_category_policies (category_key, min_advance_notice_days, reliever_required, max_consecutive_days, require_paid_leave_exhausted) VALUES
  ('casual', 0, 1, NULL, 0),
  ('sick', 0, 1, NULL, 0),
  ('without_pay', 0, 1, NULL, 0);

-- Leave Applications Table (Self Service -> Leave Application). One row per
-- submitted application. Submitting one (POST /api/leave-applications)
-- immediately deducts day_count from the matching leave_balances column for
-- that account (casual/sick/without_pay -> casual_leave/sick_leave/
-- leave_without_pay) — status below is only the review label shown back to
-- the account on this page, it doesn't gate the deduction. approver_id is
-- informational (who the account picked as their Approver), always an
-- Admin/Superadmin account — see GET /api/leave-applications/approvers.
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
);

-- Budgets Table (Admin creates a Budget Name before importing an Excel sheet into it)
-- The original uploaded Excel file is kept (original_filename + file_data) so the Admin
-- can always re-download/view exactly what was imported.
-- Declared BEFORE entries because entries.budget_id references budgets(id).
CREATE TABLE IF NOT EXISTS budgets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  budget_name VARCHAR(150) NOT NULL,
  created_by INT,
  original_filename VARCHAR(255) DEFAULT NULL,
  file_mimetype VARCHAR(150) DEFAULT NULL,
  file_data LONGBLOB DEFAULT NULL,
  -- Admin-set allowed Delivery Date window for every MPR Entry created under this
  -- Budget (both NULL = no restriction). Enforced server-side in POST/PUT /api/entries.
  delivery_date_from DATE DEFAULT NULL,
  delivery_date_to DATE DEFAULT NULL,
  -- "Submit" gate on the Admin's Data Import page: a Budget stays hidden from Users
  -- (is_published = FALSE) until the Admin reviews the imported Excel data and clicks
  -- Submit. GET /api/budgets filters unpublished Budgets out for non-admin callers.
  is_published TINYINT(1) NOT NULL DEFAULT 0,
  published_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Budget Items Table (one row per imported Excel row)
-- Excel header: Sl.No. | Project Name | Req. No. | MRF No | Date | Description of Materials |
-- Unit | Specification | Req. Qty | Purchase Order Qty | Received Qty | Balance Qty |
-- Entry User | Aproved Date | App. User | Site Sup. Date
CREATE TABLE IF NOT EXISTS budget_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  budget_id INT NOT NULL,
  sl_no VARCHAR(30),
  project_name VARCHAR(150),
  req_no VARCHAR(100),
  mrf_no VARCHAR(100),
  item_date VARCHAR(50),
  description VARCHAR(255),
  unit VARCHAR(50),
  specification VARCHAR(255),
  req_qty VARCHAR(50),
  po_qty VARCHAR(50),
  received_qty VARCHAR(50),
  balance_qty VARCHAR(50),
  entry_user VARCHAR(100),
  approved_date VARCHAR(50),
  app_user VARCHAR(100),
  site_sup_date VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE
);

-- Entries Table (Multiple MPRs per Job)
-- budget_id: every MPR entry is now created FROM a specific Budget (User must pick a
-- Budget the Admin has created & imported, then enters MPRs under it). Nullable so
-- older rows created before this feature existed don't break; new inserts always set
-- it from the server side (never trusted blindly from a client that skips the Budget step).
CREATE TABLE IF NOT EXISTS entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entry_date DATE NOT NULL,
  job_name VARCHAR(30) NOT NULL,
  budget_id INT NULL,
  project_id INT NOT NULL,
  job_id INT NOT NULL,
  mpr_id INT NOT NULL,
  -- Exact imported Budget Excel row (budget_items.id) this entry's Item Name was
  -- picked from. An MRF No can carry several DIFFERENT line items that share the
  -- exact same "Description of Materials" text (e.g. same material, different Qty/
  -- Specification/Sl.No.) — matching purely by description text would silently
  -- collapse those into one, so this column pins each entry to its own specific
  -- source row. Nullable for older entries created before this column existed
  -- (those still fall back to the description-text match in GET /api/entries).
  budget_item_id INT NULL,
  -- Must stay >= budget_items.description's length (VARCHAR(255)) — this is matched
  -- against that column (budget_id + MRF No + Description) to pull Specification/Qty/
  -- etc. into Job Entry Details for older rows without a budget_item_id. If this is
  -- ever shorter, a long Description gets silently truncated on insert and the match
  -- fails, leaving Qty blank.
  item_name VARCHAR(255) NOT NULL,
  -- How much of this Item's Requisitioned Qty (budget_items.req_qty) THIS entry is
  -- for. Editable by the user when creating/editing an entry, but capped server-side
  -- so it (plus every other of THIS SAME user's active entries against the same
  -- budget_item_id) can never exceed that item's original imported req_qty. When the
  -- user lowers this on an edit, the freed-up balance becomes selectable again for a
  -- NEW entry against the same Item (even reusing the same MPR No) with its own
  -- Delivery Date — see POST/PUT /api/entries. NULL for older entries created before
  -- this column existed.
  requisitioned_qty DECIMAL(14,2) NULL,
  delivery_date DATE NOT NULL,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- "Job Recycle" soft delete: a User can delete their own (unlocked) entry, or an
  -- Admin can delete any entry — either way this only sets deleted_at/deleted_by
  -- instead of erasing the row, so the Admin can review and Restore it from the
  -- Recycle bin (Admin Panel -> Reports -> Job Recycle). A deleted entry's MPR No
  -- becomes usable again. Only an Admin permanently erasing it from the Recycle bin
  -- actually removes the row.
  deleted_at TIMESTAMP NULL DEFAULT NULL,
  deleted_by INT NULL DEFAULT NULL,
  FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (mpr_id) REFERENCES mpr_numbers(id) ON DELETE CASCADE,
  FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (budget_item_id) REFERENCES budget_items(id) ON DELETE SET NULL,
  -- GET /api/entries and /api/entries/mpr-usage both start with
  -- `WHERE e.deleted_at IS NULL`, and a plain 'user' account (the vast
  -- majority of accounts) additionally filters `AND e.created_by = ?` —
  -- created_by has no FK (an entry's creator can be deleted without taking
  -- their entries with them), so without this it was never indexed at all.
  -- This leading-deleted_at composite serves both the Admin's
  -- deleted_at-only scan and every regular user's deleted_at+created_by one.
  KEY idx_entries_deleted_created (deleted_at, created_by)
);

-- Budget Submissions Table (a User marks a Budget as "done" once they've entered
-- every Job/MPR they intend to for it). Recorded per (budget_id, user_id): once a
-- row exists here for a given User + Budget, that User can no longer create new
-- MPR Entries under that Budget (enforced server-side in POST /api/entries).
CREATE TABLE IF NOT EXISTS budget_submissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  budget_id INT NOT NULL,
  user_id INT NOT NULL,
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_budget_user (budget_id, user_id),
  FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Personal Data Table (ProfilePage.tsx -> PersonalDataForm.tsx) — one row per
-- user, created on first save from the Personal Data screen. Position and
-- Department are deliberately NOT columns here: they're read live from
-- all_employees (via all_employees.user_id) instead, so the Employees module
-- (Admin Panel -> Employees) stays the single source of truth for both.
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
);

-- Asset Management (Employee Profile -> My Assets / New Requisition /
-- Requisition Status, plus Admin Panel -> Asset Management,
-- AssetManagementRoutes.ts) — inventory, employee requests, and the
-- assignment/return history for each item. See AssetManagementRoutes.ts for
-- the full approval workflow (Line Manager -> IT/Admin -> Handover).
CREATE TABLE IF NOT EXISTS assets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  asset_tag VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  serial_number VARCHAR(150) NULL,
  purchase_date DATE NULL,
  status ENUM('available','assigned','maintenance','disposed') NOT NULL DEFAULT 'available',
  condition_note VARCHAR(255) NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Server Profiles (Admin Panel -> Servers, Superadmin-only,
-- ServerProfileRoutes.ts) — the centrally managed catalog of backend
-- deployments (IP/URL) the Android APK build can switch between after
-- login. See ServerProfileRoutes.ts for the full reasoning.
CREATE TABLE IF NOT EXISTS server_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  url VARCHAR(255) NOT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS asset_requisitions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_user_id INT NOT NULL,
  asset_category VARCHAR(100) NOT NULL,
  reason TEXT NOT NULL,
  urgency ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  target_date DATE NULL,
  attachment_filename VARCHAR(255) NULL,
  attachment_mimetype VARCHAR(150) NULL,
  attachment_data LONGBLOB NULL,
  status ENUM('pending','manager_approved','approved','rejected','dispatched','fulfilled') NOT NULL DEFAULT 'pending',
  manager_id INT NULL,
  manager_decided_at TIMESTAMP NULL DEFAULT NULL,
  manager_remarks TEXT NULL,
  admin_decided_by INT NULL,
  admin_decided_at TIMESTAMP NULL DEFAULT NULL,
  rejection_reason TEXT NULL,
  assigned_asset_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (admin_decided_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (assigned_asset_id) REFERENCES assets(id) ON DELETE SET NULL
);

-- Line items on a requisition (New Requisition can ask for several things
-- at once — e.g. "Stapler x2" + "A4 Paper x5 reams" — each with its own
-- purpose/unit/quantity). asset_requisitions.asset_category/reason still
-- hold a one-line summary of these for anything that only needs a label.
CREATE TABLE IF NOT EXISTS asset_requisition_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  requisition_id INT NOT NULL,
  item_name VARCHAR(150) NOT NULL,
  purpose TEXT NOT NULL,
  unit VARCHAR(50) NOT NULL,
  quantity DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (requisition_id) REFERENCES asset_requisitions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS asset_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  asset_id INT NOT NULL,
  employee_user_id INT NOT NULL,
  requisition_id INT NULL,
  assigned_date DATE NOT NULL,
  returned_date DATE NULL,
  condition_on_assign ENUM('new','good') NOT NULL DEFAULT 'good',
  condition_on_return ENUM('good','damaged','lost') NULL,
  assigned_by INT NOT NULL,
  acknowledged_at TIMESTAMP NULL DEFAULT NULL,
  return_requested_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (requisition_id) REFERENCES asset_requisitions(id) ON DELETE SET NULL,
  FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE CASCADE
);

-- Global Calendar (Admin Panel -> Holidays, holidayRoutes.ts) — one row per
-- Weekend/Holiday date, gated behind the 'holidays' Admin Panel module. Every
-- signed-in account can READ this table (GET /api/holidays); only accounts
-- granted 'holidays' may write to it. A date in here is excluded from Absent
-- in both the Monthly/Date-Wise Attendance Report and every account's own
-- Timesheet.
CREATE TABLE IF NOT EXISTS holiday_calendar (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entry_date DATE NOT NULL,
  day_type ENUM('holiday', 'weekend') NOT NULL DEFAULT 'holiday',
  title VARCHAR(150) NOT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_holiday_entry_date (entry_date),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Entry Edit History Table (server-side audit trail — one row per changed field per
-- save). Job Name and Job Duration are shared across every MPR row of the same Job,
-- so an edit to either is logged against EVERY entry under that Job, not just the row
-- that was open when the edit was made. Admin-only (Admin Panel -> Reports -> History).
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
);

-- Permanent Delete Log (Superadmin-only — see GET /api/entries/permanent-delete-log,
-- gated by requireSuperAdmin directly rather than a grantable module, since this
-- exists specifically so a Superadmin can see an Admin's permanent erases too, not
-- just ones an Admin was given visibility into). One row per entry ever erased from
-- the Job Recycle bin via DELETE /api/entries/:id/permanent — that endpoint hard-
-- deletes the entries row itself (no FK to entries here on purpose: the row this
-- refers to is gone by the time this log is read), so every identifying field is a
-- plain snapshot taken right before the DELETE, not a live join. permanently_deleted_by
-- has no ON DELETE CASCADE either, and *_name columns are captured as plain text so
-- the log still reads correctly even if that user's own account is later removed.
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
);

-- Delivery Date "minimum lead time" conditions (Admin Panel -> PEPM Manage ->
-- Data Import -> Condition Set). Two independent condition_types: "entry"
-- (New Job Entry / Add MPR to Job) and "job_edit" (changing an EXISTING
-- entry's Delivery Date). Each has one Global row (scope='global',
-- scope_id=0) plus optional Project/Budget override rows; scope_id is 0
-- (not NULL) for the Global row so the unique key can actually enforce
-- "one Global row per condition_type" — MySQL treats every NULL in a
-- unique index as distinct, which would silently allow duplicate Global
-- rows otherwise. Resolution order (see deliveryDateConditions.ts):
-- Budget override > Project override > Global > nothing configured/enabled
-- = unrestricted. apply_to_admins opts an Admin/Superadmin INTO the same
-- limit too (off by default, since every other lock in this app already
-- exempts them).
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
);

INSERT IGNORE INTO delivery_date_conditions (condition_type, scope, scope_id, min_lead_days, apply_to_admins, enabled) VALUES
  ('entry', 'global', 0, 0, 0, 0),
  ('job_edit', 'global', 0, 0, 0, 0);

-- Job Edit Approval queue (Job Edit -> Add MPR to a Final-Submitted Job / Delete an
-- MPR from one, when the acting User only has the can_job_edit permission, not
-- Admin/Superadmin). Instead of applying immediately, the action is queued here and
-- only takes effect once an Admin with the "editlog" module (Admin Panel -> PEPM
-- Manage -> Edit Log) approves it — see POST /api/job-edits/:id/act. payload holds
-- the proposed change as JSON text (add_item: mpr_no/mpr_id/budget_item_id/item_name/
-- requisitioned_qty/delivery_date; delete_entry: not needed, entry_id below already
-- points at the row). entry_id is NULL for a still-pending add_item (there is no real
-- entries row yet) and set once approved (see POST /api/job-edits/:id/act).
CREATE TABLE IF NOT EXISTS job_edit_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  -- NULL for a still-pending 'add_job' request (Job Edit's "Add New Job") — there's
  -- no real Job yet to point at, only what's proposed in payload; backfilled with
  -- the newly created Job's id once an Admin approves it.
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
);

-- Remote Attendance Table (one row per User per Project per calendar day)
-- A User checks in/out for a Project they have access to from the User Panel; the
-- server only accepts it if the device's reported coordinates fall inside that
-- Project's location_radius circle around location_lat/location_lng (a Project with
-- no pin/radius set yet can't take attendance at all). check_in_* is filled on Check
-- In, check_out_* on a later same-day Check Out.
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
);

-- Employee Tracking Table (Admin Panel -> Employee Tracking module) — every
-- location ping the APK's background service sends (roughly every 5-10 minutes,
-- foreground or background) while the account has can_use_tracking. Full
-- history is kept (not just the latest point) so an Admin/Superadmin can both
-- see everyone's CURRENT position (latest row per user) and play back where a
-- given user has been on a given day.
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
);

-- Notices Table (Superadmin/Admin -> User Notice popup, shown to the User right
-- after they log in). content_html is free-form text/HTML the Admin composes;
-- lottie_json (pasted Lottie animation JSON) OR lottie_url (a hosted .json/.lottie
-- link) can optionally be set to show a custom animation above the text — if both
-- are set, lottie_json wins. target_type = 'all' shows this to every plain 'user'
-- account; 'specific' restricts it to whichever users are listed in notice_targets.
-- is_active lets an Admin pull a notice down without deleting it (and its history).
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
);

-- Which specific Users a 'specific'-targeted Notice goes to (ignored/empty for
-- target_type = 'all' notices, which go to every plain 'user' account instead).
CREATE TABLE IF NOT EXISTS notice_targets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NOT NULL,
  user_id INT NOT NULL,
  UNIQUE KEY unique_notice_user (notice_id, user_id),
  FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Per-user "seen/closed this Notice" record — once a User dismisses a Notice's
-- popup it never shows again for them (but keeps showing to anyone else it's
-- targeted at who hasn't dismissed it yet).
CREATE TABLE IF NOT EXISTS notice_dismissals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NOT NULL,
  user_id INT NOT NULL,
  dismissed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_notice_user_dismiss (notice_id, user_id),
  FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Employee Directory (Admin Panel -> Employees, gated by the "employees"
-- AdminModuleKey — a Superadmin always has it, an Admin/User only once granted
-- via module_permissions). Plain hand-entered company roster. user_id is set
-- only when this Employee was also given a login account at creation time (see
-- POST /api/employees create_login) — most listed employees still have none.
-- Column names/shapes mirror an existing `all_employees` export 1:1 so that
-- data can be imported straight into this table.
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
  user_id INT NULL,
  -- Employee Info tab
  middle_name VARCHAR(255) NULL,
  gender VARCHAR(20) NULL,
  date_of_birth DATE NULL,
  nid_ssn VARCHAR(50) NULL,
  nationality VARCHAR(100) NULL,
  marital_status VARCHAR(30) NULL,
  blood_group VARCHAR(10) NULL,
  religion VARCHAR(50) NULL,
  is_foreigner TINYINT(1) NOT NULL DEFAULT 0,
  -- Status tab
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
  -- Contact tab
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
  permanent_zip VARCHAR(20) NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Supervisor assignments for an Employee Directory row (Admin Panel ->
-- Employees -> Edit -> Supervisor tab). Both employee_id and supervisor_id
-- point at all_employees.id — the Supervisor is always picked from the same
-- Employee list, never typed free-hand. A row can have more than one
-- supervisor recorded over time; at most one should be flagged is_direct at
-- a time per employee (enforced in the app layer, not a DB constraint, so a
-- historical/secondary supervisor can still be kept on file).
CREATE TABLE IF NOT EXISTS employee_supervisors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  supervisor_id INT NOT NULL,
  effective_date DATE NULL,
  is_direct TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
  FOREIGN KEY (supervisor_id) REFERENCES all_employees(id) ON DELETE CASCADE
);

-- Employee Transfer history (Admin Panel -> Employees -> "Transfer / Change
-- Role"). One row per Department/Designation/Supervisor change made to an
-- all_employees row — keeps the FROM and TO value of each field so the
-- Employee's job history stays auditable instead of being silently
-- overwritten the way a plain "Edit Employee" save does. Also self-healed by
-- ensureEmployeeTransferSchema() in EmployeeTransferRoutes.ts for databases
-- created before this table existed.
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
);

-- Movement Claims Table — a free-form (not tied to a fixed Project geofence) point
-- A -> point B travel record: a User checks in with a Purpose (why/where they're
-- heading out for office work), then later checks out once they reach/finish there.
-- Used for TA/DA-style reimbursement review (Admin Panel -> Movement Claims). Only
-- one row per user_id may have status = 'open' at a time (enforced server-side in
-- POST /api/claims/check-in). distance_km is the straight-line distance between the
-- check-in and check-out points, computed on check-out.
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
);

-- Conveyance Bill Claim (User Panel) — a User-submitted expense claim filled in by
-- hand (optionally spanning several days for a multi-day tour, optionally with a
-- receipt attachment), separate from the live GPS check-in/out `claims` table above.
-- Starts 'pending'; an Admin with the "conveyance" module Approves (which attaches
-- it onto a conveyance_bills row as a conveyance_bill_items line, source =
-- 'user_claim') or Rejects it with admin_remarks. See server.ts /api/user-claims*.
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
);

-- conveyance_bill_items also needs `source` widened to include 'user_claim' and a
-- new user_claim_id column (the server auto-migrates this on startup too):
-- ALTER TABLE conveyance_bill_items
--   MODIFY COLUMN source ENUM('movement_claim','manual','user_claim') NOT NULL DEFAULT 'manual',
--   ADD COLUMN user_claim_id INT NULL UNIQUE AFTER claim_id,
--   ADD FOREIGN KEY (user_claim_id) REFERENCES user_claims(id) ON DELETE SET NULL;

-- Conveyance Disbursement (Admin Panel -> Conveyance Disbursement, its own
-- "disbursement" AdminModuleKey) — records that a conveyance_bills row has
-- actually been paid out, separately from the Bill/its items being built and
-- approved under the "conveyance" module. voucher_no is reprinted on the
-- Payment Voucher PDF every time it's re-opened. The server auto-migrates
-- this on startup too (server.ts, right after the conveyance_bills table):
-- ALTER TABLE conveyance_bills
--   ADD COLUMN is_disbursed TINYINT(1) NOT NULL DEFAULT 0,
--   ADD COLUMN voucher_no VARCHAR(100) NULL,
--   ADD COLUMN disbursed_at TIMESTAMP NULL DEFAULT NULL,
--   ADD COLUMN disbursed_by INT NULL,
--   ADD FOREIGN KEY (disbursed_by) REFERENCES users(id) ON DELETE SET NULL;

-- Lets a User's Conveyance Bill Claim (user_claims, above) reference one or more
-- of their OWN completed Movement Claims (claims — a live GPS check-in/out), each
-- with its own Amount, instead of only a single free-typed Claim Amount. A given
-- check-in/out (claim_id) may be referenced by AT MOST ONE Conveyance Bill Claim
-- ever (UNIQUE claim_id below) — once used it drops out of the "available to
-- reference" picker (GET /api/claims/available) for good, whether the claim it
-- was attached to is still pending, approved, or was rejected (rejection frees it
-- again — see POST /api/user-claims/:id/decision). Deleting the parent
-- user_claims row (a User withdrawing a still-pending claim) cascades here too,
-- immediately freeing every check-in/out it referenced. user_claims.amount is the
-- SUM of these rows' amounts whenever any exist (computed server-side on submit —
-- see POST /api/user-claims), otherwise it's the User's own free-typed figure as
-- before.
CREATE TABLE IF NOT EXISTS user_claim_references (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_claim_id INT NOT NULL,
  claim_id INT NOT NULL UNIQUE,
  amount DECIMAL(12, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_claim_id) REFERENCES user_claims(id) ON DELETE CASCADE,
  FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
);

-- ============================================================================
-- Approval Workflow TEMPLATES (Dynamic Approval Engine — Part 1 of 5).
-- Superadmin can pre-build any number of named templates, each an ORDERED list
-- of Layers/Steps, one per request_type (Conveyance Bill Claim / Leave
-- Application / Timesheet=Attendance Correction). This sits ALONGSIDE the old
-- single-global-chain engine (approval_chain_steps/approval_requests further
-- below) — that table/engine is left untouched here; a later migration moves
-- it into this new system without breaking any in-flight request.
-- ============================================================================
CREATE TABLE IF NOT EXISTS approval_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  request_type ENUM('conveyance','leave','timesheet','asset') NOT NULL,
  -- Company-wide fallback for this request_type — used whenever a submitting
  -- Employee has no row in employee_template_assignments for this
  -- request_type. "At most one default per request_type" is enforced in the
  -- API layer, not a DB constraint — MySQL can't express a conditional-unique
  -- index this cleanly without a generated column.
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- One row per Layer/Step inside a template, in step_order (1, 2, 3...).
-- Deliberately holds NO approver column itself — a step's approver(s) live in
-- approval_template_step_approvers below, since a step can hold more than one
-- Employee (see that table's comment).
CREATE TABLE IF NOT EXISTS approval_template_steps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  template_id INT NOT NULL,
  step_order INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_template_step_order (template_id, step_order),
  FOREIGN KEY (template_id) REFERENCES approval_templates(id) ON DELETE CASCADE
);

-- One or more Approvers per Step. ANY ONE of a step's approvers Approving is
-- enough to clear that step and move the request to the next one — this is
-- how "put a whole Department on Layer 2" is modeled: every member of that
-- Department gets their own row here against the same step_id. A single
-- named individual on a step is just the n=1 case of this same table.
CREATE TABLE IF NOT EXISTS approval_template_step_approvers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  step_id INT NOT NULL,
  user_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_step_user (step_id, user_id),
  FOREIGN KEY (step_id) REFERENCES approval_template_steps(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Per-Employee, per-Request-Type template pick (Admin Panel -> new "Template
-- Assignment" screen). At most one row per (employee_user_id, request_type) —
-- the active row is REPLACED, never duplicated, whenever an Admin re-assigns
-- that Employee's template for that request type. Missing row = no explicit
-- assignment -> falls back to approval_templates.is_default for that
-- request_type -> if there's no default either, the request auto-approves.
CREATE TABLE IF NOT EXISTS employee_template_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_user_id INT NOT NULL,
  request_type ENUM('conveyance','leave','timesheet','asset') NOT NULL,
  template_id INT NOT NULL,
  assigned_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_employee_request_type (employee_user_id, request_type),
  FOREIGN KEY (employee_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES approval_templates(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Dynamic Approval Engine (Part 3) — links an approval_requests row to the
-- Template driving it (NULL = still on the OLD global chain above). The
-- server also auto-adds this column on startup if it's missing; only needed
-- here if that self-healing migration is skipped:
-- ALTER TABLE approval_requests ADD COLUMN template_id INT NULL;
-- ALTER TABLE approval_requests ADD FOREIGN KEY (template_id) REFERENCES approval_templates(id) ON DELETE SET NULL;

-- If you already have an existing database, run this once to add Remote Attendance
-- (the server also auto-creates this on startup, so this is only needed if that
-- self-healing migration is skipped):
-- CREATE TABLE IF NOT EXISTS attendance (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   user_id INT NOT NULL,
--   project_id INT NOT NULL,
--   attendance_date DATE NOT NULL,
--   check_in_at TIMESTAMP NULL DEFAULT NULL,
--   check_in_lat DECIMAL(10, 7) NULL,
--   check_in_lng DECIMAL(10, 7) NULL,
--   check_in_distance_m INT NULL,
--   check_out_at TIMESTAMP NULL DEFAULT NULL,
--   check_out_lat DECIMAL(10, 7) NULL,
--   check_out_lng DECIMAL(10, 7) NULL,
--   check_out_distance_m INT NULL,
--   check_in_remarks TEXT NULL,
--   check_out_remarks TEXT NULL,
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--   UNIQUE KEY unique_user_project_date (user_id, project_id, attendance_date),
--   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
--   FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
-- );

-- Importing a Budget's Excel: every MRF No in the sheet is auto-added to mpr_numbers
-- (Approved MPR list) if it doesn't already exist, and every Project Name is auto-added
-- to projects if it doesn't already exist — so imported rows are immediately usable
-- in the User's MPR Entry form.

-- If you already have an existing database, run this once to add the new column:
-- ALTER TABLE entries ADD COLUMN job_name VARCHAR(30) NOT NULL DEFAULT '' AFTER entry_date;

-- If you already have an existing database, run this once to add the User-Project
-- permissions table (Admin Panel -> Users -> "Manage Projects"):
-- CREATE TABLE IF NOT EXISTS user_project_permissions (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   user_id INT NOT NULL,
--   project_id INT NOT NULL,
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--   UNIQUE KEY unique_user_project (user_id, project_id),
--   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
--   FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
-- );

-- If you already have an existing database, run this once to store the original
-- imported Excel file against each Budget:
-- ALTER TABLE budgets ADD COLUMN original_filename VARCHAR(255) DEFAULT NULL;
-- ALTER TABLE budgets ADD COLUMN file_mimetype VARCHAR(150) DEFAULT NULL;
-- ALTER TABLE budgets ADD COLUMN file_data LONGBLOB DEFAULT NULL;

-- If you already have an existing database, run this once to let the Admin set an
-- allowed Delivery Date window per Budget (the server also auto-adds these columns
-- on startup, so this is only needed if that self-healing migration is skipped):
-- ALTER TABLE budgets ADD COLUMN delivery_date_from DATE DEFAULT NULL;
-- ALTER TABLE budgets ADD COLUMN delivery_date_to DATE DEFAULT NULL;

-- If you already have an existing database, run this once to add the "Submit" (publish)
-- gate for the Import Rate File / Import Budget from Excel page — a Budget stays hidden
-- from Users until the Admin clicks Submit (the server also auto-adds these columns on
-- startup, so this is only needed if that self-healing migration is skipped):
-- ALTER TABLE budgets ADD COLUMN is_published TINYINT(1) NOT NULL DEFAULT 0;
-- ALTER TABLE budgets ADD COLUMN published_at TIMESTAMP NULL DEFAULT NULL;

-- If you already have an existing database, run this once so every new MPR Entry is
-- tied to the Budget it was created under (Users must pick a Budget first):
-- ALTER TABLE entries ADD COLUMN budget_id INT NULL AFTER job_name;
-- ALTER TABLE entries ADD CONSTRAINT fk_entries_budget FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE SET NULL;

-- If you already have an existing database, run this once to add the "Submit Budget"
-- lock feature (a User marks a Budget as finished; they can then no longer add new
-- entries under it):
-- CREATE TABLE IF NOT EXISTS budget_submissions (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   budget_id INT NOT NULL,
--   user_id INT NOT NULL,
--   submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--   UNIQUE KEY unique_budget_user (budget_id, user_id),
--   FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE,
--   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
-- );

-- If you already have an existing database, run this once to add the entry edit
-- history audit table (the server also auto-creates this on startup, so this is only
-- needed if that self-healing migration is skipped):
-- CREATE TABLE IF NOT EXISTS entry_edit_history (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   entry_id INT NOT NULL,
--   edited_by INT,
--   field_name VARCHAR(50) NOT NULL,
--   old_value VARCHAR(255),
--   new_value VARCHAR(255),
--   edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--   FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
--   FOREIGN KEY (edited_by) REFERENCES users(id) ON DELETE SET NULL
-- );

-- If you already have an existing database, run this once to add the "Job Recycle"
-- soft-delete columns (the server also auto-adds these columns on startup, so this
-- is only needed if that self-healing migration is skipped):
-- ALTER TABLE entries ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL;
-- ALTER TABLE entries ADD COLUMN deleted_by INT NULL DEFAULT NULL;
-- ALTER TABLE entries ADD CONSTRAINT fk_entries_deleted_by FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL;

-- If you already have an existing database, run this once so each entry pins the
-- EXACT imported Budget Excel row (budget_items.id) its Item Name came from, instead
-- of only being matched back to it by description text (which silently collapsed
-- multiple Excel rows that share the same Description into one -- the server also
-- auto-adds this column on startup, so this is only needed if that self-healing
-- migration is skipped):
-- ALTER TABLE entries ADD COLUMN budget_item_id INT NULL;
-- ALTER TABLE entries ADD CONSTRAINT fk_entries_budget_item FOREIGN KEY (budget_item_id) REFERENCES budget_items(id) ON DELETE SET NULL;

-- If you already have an existing database, run this once to add Bulk User Import
-- (Admin Panel -> Users -> Bulk Add Users) support — these users log in with just a
-- Project Name (no email) + Password (the server also auto-adds these on startup, so
-- this is only needed if that self-healing migration is skipped):
-- ALTER TABLE users ADD COLUMN username VARCHAR(150) UNIQUE NULL AFTER email;
-- ALTER TABLE users MODIFY COLUMN email VARCHAR(150) NULL;

-- If you already have an existing database, run this once to add the per-entry
-- editable Requisitioned Qty column (splitting an Item's Qty across several entries
-- with their own Delivery Dates -- the server also auto-adds this column on startup,
-- so this is only needed if that self-healing migration is skipped):
-- ALTER TABLE entries ADD COLUMN requisitioned_qty DECIMAL(14,2) NULL;

-- If you already have an existing database, run this once to add the Superadmin
-- role and per-Admin module access control (the server also auto-runs this on
-- startup, so this is only needed if that self-healing migration is skipped):
-- ALTER TABLE users MODIFY COLUMN role ENUM('superadmin','admin','user') DEFAULT 'user';
-- CREATE TABLE IF NOT EXISTS admin_module_permissions (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   user_id INT NOT NULL,
--   module_key VARCHAR(50) NOT NULL,
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--   UNIQUE KEY unique_user_module (user_id, module_key),
--   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
-- );

-- If you already have an existing database, run this once to add the Notice
-- feature (Superadmin/Admin -> User popup notices with optional custom Lottie
-- animation — the server also auto-creates these on startup, so this is only
-- needed if that self-healing migration is skipped):
-- CREATE TABLE IF NOT EXISTS notices (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   title VARCHAR(200) NOT NULL,
--   content_html MEDIUMTEXT NOT NULL,
--   lottie_json MEDIUMTEXT NULL,
--   lottie_url VARCHAR(500) NULL,
--   target_type ENUM('all','specific') NOT NULL DEFAULT 'all',
--   is_active TINYINT(1) NOT NULL DEFAULT 1,
--   created_by INT NULL,
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--   updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
--   FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
-- );
-- CREATE TABLE IF NOT EXISTS notice_targets (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   notice_id INT NOT NULL,
--   user_id INT NOT NULL,
--   UNIQUE KEY unique_notice_user (notice_id, user_id),
--   FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE,
--   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
-- );
-- CREATE TABLE IF NOT EXISTS notice_dismissals (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   notice_id INT NOT NULL,
--   user_id INT NOT NULL,
--   dismissed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--   UNIQUE KEY unique_notice_user_dismiss (notice_id, user_id),
--   FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE,
--   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
-- );

-- Approval Workflow (Superadmin/Admin) — a single global, ORDERED chain of
-- Admin/Superadmin approvers (Admin Panel -> Approvals -> Manage Chain, Superadmin
-- only). Whenever ANY user Checks In or Checks Out (Remote Attendance OR Movement
-- Claims), the check-in/out itself is recorded immediately as before (this is
-- NON-BLOCKING) and, if a chain is configured, an Approval Request is also created
-- starting at step 1 -- it goes to the FIRST person in the chain, and once they
-- Approve it moves to the SECOND person, and so on, until the LAST layer approves
-- (status becomes 'approved') or anyone in the chain Rejects it (status becomes
-- 'rejected' and the chain stops there). A request created before the chain existed,
-- or while it was empty, simply never gets a row here.
CREATE TABLE IF NOT EXISTS approval_chain_steps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  step_order INT NOT NULL,
  user_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_step_order (step_order),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- One row per Check In / Check Out event that was routed through the Approval
-- Chain. total_steps is a SNAPSHOT of the chain's length at the moment this
-- request was created, so editing the chain later never changes an in-flight
-- request's expected number of layers. current_step is 1-indexed into that
-- snapshot's layer order (approval_chain_steps.step_order); once an approval at
-- current_step happens and current_step was the last one, status flips to
-- 'approved' -- a rejection at any step is terminal and stops the chain there.
-- actions_json holds the full approve/reject trail (one entry per action) as a
-- JSON array: [{step_order, approver_id, approver_name, action, remarks, acted_at}].
CREATE TABLE IF NOT EXISTS approval_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  source_type ENUM('attendance','claim','user_claim') NOT NULL,
  event_type ENUM('check_in','check_out','submit') NOT NULL,
  source_id INT NOT NULL,
  requested_by INT NOT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  current_step INT NOT NULL DEFAULT 1,
  total_steps INT NOT NULL,
  actions_json MEDIUMTEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE,
  -- GET /api/my-approvals (PendingApprovalsCard — hit on every Dashboard
  -- open, by every account) starts with `WHERE status = 'pending'`; without
  -- this index that's a full table scan of every approval request ever
  -- created, on every single Dashboard load.
  KEY idx_approval_requests_status (status)
);

-- If you already have an existing database, run this once to add the Approval
-- Workflow feature (the server also auto-creates these on startup, so this is
-- only needed if that self-healing migration is skipped):
-- CREATE TABLE IF NOT EXISTS approval_chain_steps (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   step_order INT NOT NULL,
--   user_id INT NOT NULL,
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--   UNIQUE KEY unique_step_order (step_order),
--   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
-- );
-- CREATE TABLE IF NOT EXISTS approval_requests (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   source_type ENUM('attendance','claim','user_claim') NOT NULL,
--   event_type ENUM('check_in','check_out','submit') NOT NULL,
--   source_id INT NOT NULL,
--   requested_by INT NOT NULL,
--   status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
--   current_step INT NOT NULL DEFAULT 1,
--   total_steps INT NOT NULL,
--   actions_json MEDIUMTEXT NOT NULL,
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--   updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
--   FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE
-- );

-- If you already have an existing database, run this once to let the Superadmin
-- grant an Admin access to the User Panel as well as their Admin Panel:
-- ALTER TABLE users ADD COLUMN can_access_user_panel TINYINT(1) NOT NULL DEFAULT 0;

-- If you already have an existing database, run this once for the Self Service ->
-- Leave Management module (Superadmin sets Casual/Sick/Leave-without-Pay balances,
-- and can grant other Admin/User accounts the same edit access):
-- ALTER TABLE users ADD COLUMN can_manage_leave TINYINT(1) NOT NULL DEFAULT 0;
-- CREATE TABLE IF NOT EXISTS leave_balances (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   user_id INT NOT NULL,
--   casual_leave DECIMAL(5, 1) NOT NULL DEFAULT 0,
--   sick_leave DECIMAL(5, 1) NOT NULL DEFAULT 0,
--   leave_without_pay DECIMAL(5, 1) NOT NULL DEFAULT 0,
--   updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
--   UNIQUE KEY unique_user_leave (user_id),
--   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
-- );

-- If you already have an existing database, run this once for Self Service ->
-- Leave Application (submitting one deducts from leave_balances above):
-- CREATE TABLE IF NOT EXISTS leave_applications (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   user_id INT NOT NULL,
--   leave_type ENUM('casual', 'sick', 'without_pay') NOT NULL,
--   start_date DATE NOT NULL,
--   end_date DATE NOT NULL,
--   day_count DECIMAL(5, 1) NOT NULL,
--   is_continuous TINYINT(1) NOT NULL DEFAULT 0,
--   is_prefix TINYINT(1) NOT NULL DEFAULT 0,
--   is_suffix TINYINT(1) NOT NULL DEFAULT 0,
--   is_half_day TINYINT(1) NOT NULL DEFAULT 0,
--   include_extra_work_dates TINYINT(1) NOT NULL DEFAULT 0,
--   is_foreign_leave TINYINT(1) NOT NULL DEFAULT 0,
--   purpose TEXT NOT NULL,
--   approver_id INT NOT NULL,
--   status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
--   apply_date DATE NOT NULL,
--   remarks TEXT NULL,
--   decided_by INT NULL,
--   decided_at TIMESTAMP NULL,
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
--   FOREIGN KEY (approver_id) REFERENCES users(id)
-- );
-- If you ran the above before Approve/Reject existed, also run:
-- ALTER TABLE leave_applications ADD COLUMN remarks TEXT NULL;
-- ALTER TABLE leave_applications ADD COLUMN decided_by INT NULL;
-- ALTER TABLE leave_applications ADD COLUMN decided_at TIMESTAMP NULL;

-- If you already have an existing database, run this once for Admin Panel ->
-- Branches (separate from Projects — see the CREATE TABLE branches comment
-- above for why):
-- CREATE TABLE IF NOT EXISTS branches (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   branch_name VARCHAR(150) UNIQUE NOT NULL,
--   created_by INT,
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--   location_lat DECIMAL(10, 7) NULL,
--   location_lng DECIMAL(10, 7) NULL,
--   location_label VARCHAR(255) NULL,
--   location_radius INT NULL,
--   FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
-- );

-- If you already have an existing database, run this once to add the Job Edit
-- Approval queue (Job Edit -> Add MPR to a Final-Submitted Job / Delete an MPR from
-- one, when the acting User only has the can_job_edit permission, not an Admin/
-- Superadmin) — the server also auto-creates this on startup, so this is only needed
-- if that self-healing migration is skipped:
-- CREATE TABLE IF NOT EXISTS job_edit_requests (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   job_id INT NOT NULL,
--   entry_id INT NULL,
--   action ENUM('add_item', 'delete_entry') NOT NULL,
--   payload TEXT NULL,
--   status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
--   requested_by INT NOT NULL,
--   reviewed_by INT NULL,
--   reviewed_at TIMESTAMP NULL DEFAULT NULL,
--   review_note VARCHAR(500) NULL,
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--   FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
--   FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE SET NULL,
--   FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE,
--   FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
-- );

-- No demo/seed data here.
-- The Superadmin account is created automatically on server startup from your
-- .env (ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD) — see .env.example. This
-- Superadmin then creates/promotes Admins and Users from the Admin Panel ->
-- Users tab, and controls each Admin's module access there.
-- Projects, MPR Numbers, Jobs, and Entries start empty; Admins add
-- Projects and MPR Numbers from the Admin Panel, and Jobs/Entries are created
-- as real users submit the Entry Form.
-- If you already have an existing database, run this once so a Superadmin can
-- gate Movement Claim (GPS Check In/Out) and Conveyance Bill Claim visibility on
-- the User Panel per-account, the same way every other module already works —
-- nothing shows to an Admin or User until the Superadmin explicitly grants it:
-- ALTER TABLE users ADD COLUMN can_view_movement_claims TINYINT(1) NOT NULL DEFAULT 0;
-- ALTER TABLE users ADD COLUMN can_view_conveyance_claims TINYINT(1) NOT NULL DEFAULT 0;