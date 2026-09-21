export type UserRole = 'superadmin' | 'admin' | 'user';

// Every Admin Panel tab. A Superadmin implicitly has all of these; a plain Admin
// only sees/uses the ones the Superadmin has explicitly granted via
// PUT /api/users/:id/module-permissions. Mirrors ADMIN_MODULE_KEYS in server.ts.
export type AdminModuleKey = 'projects' | 'branches' | 'mprs' | 'imports' | 'reports' | 'users' | 'recycle' | 'editlog' | 'attendance' | 'attendance_reports' | 'leave_applications' | 'notices' | 'claims' | 'approvals' | 'conveyance' | 'disbursement' | 'employees' | 'departments' | 'tracking' | 'office_attendance' | 'holidays' | 'payroll' | 'asset_management';

export const ADMIN_MODULES: { key: AdminModuleKey; label: string }[] = [
  { key: 'reports', label: 'Reports' },
  { key: 'projects', label: 'Projects' },
  { key: 'branches', label: 'Branches' },
  { key: 'mprs', label: 'MPR Numbers' },
  { key: 'imports', label: 'Data Import' },
  { key: 'users', label: 'Users' },
  { key: 'employees', label: 'Employees' },
  { key: 'departments', label: 'Departments' },
  { key: 'attendance', label: 'Remote Attendance' },
  { key: 'attendance_reports', label: 'Monthly Attendance Report' },
  // Read-only "who applied for Leave" report — separate from the
  // can_manage_leave (Leave Manage/Leave Balances) toggle and from the old
  // approver-based "Leave Approvals" page. Grantable to an Admin OR a plain
  // User account, with the same optional per-account Department scope as
  // 'attendance_reports' — see leave_application_department_access /
  // getLeaveApplicationDeptScope() in server.ts and
  // GET /api/leave-applications/report* in LeaveRoutes.ts.
  { key: 'leave_applications', label: 'Monthly Leave Application' },
  { key: 'office_attendance', label: 'Office Attendance' },
  { key: 'tracking', label: 'Employee Tracking' },
  { key: 'claims', label: 'Movement Claims' },
  { key: 'conveyance', label: 'Conveyance Bill Claim' },
  { key: 'disbursement', label: 'Conveyance Disbursement' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'notices', label: 'Notices' },
  { key: 'holidays', label: 'Holidays (Global Calendar)' },
  { key: 'payroll', label: 'Payroll' },
  { key: 'asset_management', label: 'Asset Management' },
  { key: 'recycle', label: 'Job Recycle' },
  { key: 'editlog', label: 'MPR Edit Log' }
];

// Granular per-module action layers, layered on top of the coarse module
// grant above (ADMIN_MODULES/module_permissions) — a Superadmin picks any
// combination of these per (Admin/User account, module) via Admin Panel ->
// Users -> Module Access. Independent checkboxes, not hierarchical: having
// 'delete_trash' does NOT imply 'edit_add' is also granted.
export type PermissionLayerKey = 'read' | 'edit_add' | 'entry_upload' | 'delete_trash' | 'permanent_delete';

export const PERMISSION_LAYERS: { key: PermissionLayerKey; label: string }[] = [
  { key: 'read', label: 'Read Only' },
  { key: 'edit_add', label: 'Edit/Add' },
  { key: 'entry_upload', label: 'Entry/Upload' },
  { key: 'delete_trash', label: 'Delete/Trash' },
  { key: 'permanent_delete', label: 'Permanent Delete' },
];

// Which Admin Panel modules currently enforce the PERMISSION_LAYERS above —
// being rolled out one module at a time. A module not listed here still only
// has the old coarse on/off grant (module_permissions), unaffected by any of
// this. Start: 'departments', then 'projects', then 'approvals', then 'users'.
export const PERMISSION_LAYER_MODULES: AdminModuleKey[] = ['departments', 'projects', 'approvals', 'users'];

// Global Calendar (Admin Panel -> Holidays) — one row per Weekend/Holiday
// date. Read by every account (Timesheet needs this so a Weekend/Holiday date
// never shows as "Absent"); only accounts granted the 'holidays' module may
// add/edit/delete entries (POST/PUT/DELETE /api/holidays).
export type HolidayDayType = 'holiday' | 'weekend';

export interface HolidayEntry {
  id: number;
  entry_date: string;
  day_type: HolidayDayType;
  title: string;
  created_by: number | null;
  created_at: string;
}

// "Employee Tracking" — one background location ping the APK's tracking service
// sent while the account had can_use_tracking on, roughly every 5-10 minutes,
// whether the app was in the foreground, minimized, or fully backgrounded. GET
// /api/tracking/live returns the single latest row per user (the "where is
// everyone right now" board); GET /api/tracking/history?user_id=... returns
// the full history for ONE user (for "view path today" playback).
export interface LocationPing {
  id: number;
  user_id: number;
  user_name?: string | null;
  user_email?: string | null;
  lat: number;
  lng: number;
  accuracy_m?: number | null;
  battery_pct?: number | null;
  recorded_at: string;
  created_at?: string;
}

// One row of the company-wide Employee Directory (Admin Panel -> Employees, an
// AdminModuleKey like every other tab — a Superadmin always has it, a plain
// Admin/User only once the Superadmin grants it via module_permissions). Plain
// reference data entered by hand — not tied to a login account (a User row),
// since most listed employees never get one. Field names/shapes mirror the
// `all_employees` table this was modeled after 1:1 so an existing export of
// that table can be imported straight in later.
export interface Employee {
  id: number;
  employee_id: string | null;
  name: string;
  designation: string | null;
  department: string | null;
  // The structured Department (Admin Panel -> Departments) this row is linked
  // to, if any — `department` above stays a plain-text mirror of that
  // Department's name for every existing reader that never learned about
  // department_id (Notices targeting, Attendance Reports, this panel's own
  // search/filter). null = no structured Department linked yet (a legacy row,
  // or `department` was hand-typed and never matched/created one).
  department_id?: number | null;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  created_at?: string;
  // Set once this Employee has a linked login account (see POST /api/employees
  // create_login) — null for the (still-normal) case of a directory entry with
  // no account. Lets the Employees list show a "Has Login" badge and stops the
  // Add/Edit form from offering to create a second account for the same row.
  user_id?: number | null;

  // --- Employee Info tab ---
  middle_name?: string | null;
  gender?: string | null;
  date_of_birth?: string | null;
  nid_ssn?: string | null;
  nationality?: string | null;
  marital_status?: string | null;
  blood_group?: string | null;
  religion?: string | null;
  is_foreigner?: boolean;

  // --- Status tab ---
  division?: string | null;
  branch?: string | null;
  unit?: string | null;
  status_effective_date?: string | null;
  job_status?: string | null;
  job_status_effective_date?: string | null;
  job_base?: string | null;
  job_base_effective_date?: string | null;
  review_month?: string | null;
  employment_category?: string | null;
  employment_category_effective_date?: string | null;
  designation_effective_date?: string | null;

  // --- Contact tab ---
  mobile?: string | null;
  telephone?: string | null;
  personal_email?: string | null;
  present_address?: string | null;
  present_country?: string | null;
  present_state?: string | null;
  present_city?: string | null;
  present_zip?: string | null;
  permanent_address?: string | null;
  permanent_country?: string | null;
  permanent_state?: string | null;
  permanent_city?: string | null;
  permanent_zip?: string | null;
}

// One row of Self Service -> Employee Directory (GET /api/employee-directory)
// — the read-only, company-wide roster every signed-in account can browse.
// Deliberately a narrower shape than Employee above: only directory-safe
// fields (see EmployeeDirectoryRoutes.ts's own comment for why).
export interface EmployeeDirectoryEntry {
  id: number;
  employee_id: string | null;
  name: string;
  designation: string | null;
  department: string | null;
  department_id: number | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  telephone: string | null;
  branch: string | null;
  division: string | null;
  unit: string | null;
  is_active: boolean;
  user_id: number | null;
  supervisor_name: string | null;
}

// One row of Admin Panel -> Employees -> Edit -> Supervisor tab. The
// Supervisor is always another Employee picked from the same directory
// (never typed free-hand) — supervisor_id points at that Employee's id;
// supervisor_name/supervisor_employee_code are joined in server-side for
// display only. An Employee can have their Supervisor changed, or a row
// added/removed, at any time from this tab.
export interface EmployeeSupervisor {
  id: number;
  employee_id: number;
  supervisor_id: number;
  supervisor_name: string;
  supervisor_employee_code?: string | null;
  effective_date: string | null;
  is_direct: boolean;
}

// One row of Admin Panel -> Employees -> "Transfer / Change Role" history
// (GET /api/employees/:id/transfers). Keeps the FROM and TO value of
// Department/Designation/Supervisor for a given change, so an Employee's job
// history stays auditable — see EmployeeTransferRoutes.ts.
export interface EmployeeTransfer {
  id: number;
  employee_id: number;
  from_department_id: number | null;
  from_department_name: string | null;
  to_department_id: number | null;
  to_department_name: string | null;
  from_designation: string | null;
  to_designation: string | null;
  from_supervisor_id: number | null;
  to_supervisor_id: number | null;
  from_supervisor_name?: string | null;
  to_supervisor_name?: string | null;
  effective_date: string | null;
  reason: string | null;
  action_by: number | null;
  action_by_name?: string | null;
  created_at?: string;
}

// Admin Panel -> Departments (its own 'departments' AdminModuleKey) — real
// org-structure master data, distinct from EmployeeSupervisor above (which is
// a purely informational reporting line between two Employee Directory rows
// and was never wired into approvals). A Department optionally has a
// Supervisor — a login account (users.id), not an Employee Directory row,
// since the Supervisor needs to actually act on Approval Workflow requests.
// Unless include_supervisor_approval is turned off, that Supervisor is
// automatically inserted as the first layer of the Approval Workflow for
// every request submitted by an Employee in this Department, ahead of
// whatever Approval Template applies — defaults ON, so simply setting a
// Supervisor is enough; no separate Template step needs to be built for "my
// manager approves first".
export interface Department {
  id: number;
  name: string;
  supervisor_user_id: number | null;
  supervisor_name?: string | null;
  include_supervisor_approval: boolean;
  is_active: boolean;
  created_at?: string;
}


// One layer of the global Approval Chain (Admin Panel -> Approvals -> Manage
// Chain, Superadmin-only to edit). step_order is 1-indexed — step 1 is the FIRST
// approver every Check In/Out goes to, the last step_order is the FINAL layer.
export interface ApprovalChainStep {
  id: number;
  step_order: number;
  user_id: number;
  user_name?: string | null;
  user_role?: UserRole | null;
  created_at?: string;
}

// One Check In / Check Out event routed through the Approval Chain. Created the
// moment the underlying Attendance/Claim check-in/out is recorded (non-blocking —
// the check-in/out itself already succeeded before this exists). total_steps is a
// snapshot of the chain's length at creation time; current_step (1-indexed) is
// which layer it's waiting on right now while status is 'pending'.
export interface ApprovalRequest {
  id: number;
  source_type: 'attendance' | 'claim' | 'user_claim' | 'attendance_correction';
  event_type: 'check_in' | 'check_out' | 'submit';
  source_id: number;
  requested_by: number;
  requested_by_name?: string | null;
  status: 'pending' | 'approved' | 'rejected';
  current_step: number;
  total_steps: number;
  actions: ApprovalAction[];
  created_at?: string;
  updated_at?: string;
  // Only present on rows from GET /api/approvals (joined server-side) — a short
  // human-readable label for what was checked in/out of (Project name for
  // Attendance, Purpose for a Movement Claim, Description/Category for a
  // Conveyance Bill Claim, "Date — Project" for an Attendance Correction), and
  // who's up next while still pending.
  source_label?: string;
  // Only present when source_type is 'user_claim' — the Conveyance Bill Claim's
  // Amount/Category, so the Approvals queue can show them without a second call.
  source_amount?: number | null;
  source_category?: string | null;
  // Only present when source_type is 'user_claim' AND the request has already
  // been approved — the Approved Amount the approver recorded at decision time
  // (may be less than source_amount, a partial approval). NULL while still
  // pending, rejected, or for anything approved before this feature existed.
  source_approved_amount?: number | null;
  current_approver_id?: number | null;
  current_approver_name?: string | null;
}

// One entry in an ApprovalRequest's approve/reject trail.
export interface ApprovalAction {
  step_order: number;
  approver_id: number;
  approver_name: string;
  action: 'approved' | 'rejected';
  remarks: string | null;
  acted_at: string;
  // Only present on a 'user_claim' Approve — the Approved Amount this Layer
  // decided (whatever they submitted, or the running/original amount
  // carried forward if they left it untouched). amount_edited is true only
  // when this differs from whatever was on record just before this action,
  // so the Admin's Conveyance Bill Claim history can tell "approved as-is"
  // apart from "partially approved here" and count real edits across the
  // whole chain. See performApprovalAction server-side.
  approved_amount?: number | null;
  amount_edited?: boolean;
}

// Lightweight summary embedded onto an AttendanceRecord/ClaimRecord (from
// attachApprovalStatuses server-side) — null means no chain was configured yet
// when that check-in/out happened, so there's nothing to show.
export interface ApprovalStatusSummary {
  status: 'pending' | 'approved' | 'rejected';
  current_step: number;
  total_steps: number;
}

// Same idea as ApprovalStatusSummary, but for an Attendance Correction request
// (see attachAttendanceCorrectionApproval server-side) — adds who the request
// is currently sitting with (null once it's no longer 'pending') and the full
// approve/reject trail so far, so Timesheet can show exactly which link of the
// chain a correction is waiting on, or who acted (and why) once it's decided.
export interface AttendanceCorrectionApproval extends ApprovalStatusSummary {
  current_approver_name?: string | null;
  actions?: ApprovalAction[];
}

export interface User {
  id: number;
  name: string;
  // Null for bulk-created (Project Name + Password) users.
  email: string | null;
  // Login ID for bulk-created users — the Project Name with spaces stripped +
  // lowercased. Null for regular email-based accounts.
  username?: string | null;
  role: UserRole;
  created_at?: string;
  // Coordinates captured at the user's most recent login (location permission is
  // mandatory — see AuthScreen.tsx). Only the latest login is kept, not a history.
  last_login_lat?: number | null;
  last_login_lng?: number | null;
  last_login_at?: string | null;
  // Feature permissions the Admin toggles per user (Admin Panel -> Users).
  // can_edit_delivery_date: edit Delivery Date after Submit, and even after Final
  // Submit — every other field stays locked either way. ON by default.
  // can_job_edit: unlocks the "Job Edit" section on the User Page (add/edit/delete
  // MPR inside an already Final-Submitted Job). OFF by default.
  can_edit_delivery_date?: boolean;
  can_job_edit?: boolean;
  // Admin/Superadmin-granted: shows the Remote Attendance Check In/Out card on
  // THIS account's own Dashboard (User Panel) at all. Always true for role ===
  // 'superadmin'. OFF by default for 'admin'/'user', switched on per account via
  // PUT /api/users/:id/feature-permissions. Separate from the "attendance" Admin
  // Panel module (AdminModuleKey), which is about reviewing everyone ELSE's
  // records, not this account's own ability to check in/out.
  can_use_attendance?: boolean;
  // Admin/Superadmin-granted: pins this account (role 'user' OR 'admin') to
  // exactly one Project for Remote Attendance — set via the "Attend. Project"
  // column next to can_use_attendance above (Admin Panel -> Users). Null/
  // undefined means unrestricted (falls back to whatever Projects the account
  // can otherwise see). When set, the account's own Attendance card only
  // offers this one Project and the server rejects check-in/check-out against
  // any other — even for role 'admin', which is otherwise unrestricted on
  // Projects. Never applies to 'superadmin'. Completely separate from
  // user_project_permissions (the "Projects" column/Manage Projects modal),
  // which is only ever about the Budget/Jobs/MPR workflow.
  attendance_project_id?: number | null;
  // Admin/Superadmin-granted: lets THIS account's APK send background location
  // pings for Employee Tracking (see LocationPing below). Always true for role
  // === 'superadmin'. OFF by default for 'admin'/'user', switched on per account
  // via PUT /api/users/:id/feature-permissions. Separate from the "tracking"
  // Admin Panel module (AdminModuleKey), which is about VIEWING everyone else's
  // live location, not this account's own device reporting its position.
  can_use_tracking?: boolean;
  // Which Admin Panel modules this account can open. Only meaningful when
  // role === 'admin' (set by the Superadmin) — empty/absent for 'user' rows, and
  // irrelevant for 'superadmin' (which always has every module).
  module_permissions?: AdminModuleKey[];
  // Per-module granular permission layers (Read Only/Edit-Add/Entry-Upload/
  // Delete-Trash/Permanent Delete — see PERMISSION_LAYERS below), layered ON
  // TOP of module_permissions above: the account still needs the module
  // itself granted there for any of this to matter. Only meaningful for
  // modules listed in PERMISSION_LAYER_MODULES — rolled out module by
  // module, starting with 'departments'. Absent/empty for a granted module
  // means "every layer except Permanent Delete" (preserves the pre-existing
  // full-access behavior for anyone already granted that module before this
  // feature existed) — see requireModuleLayer() in server.ts.
  module_permission_layers?: Partial<Record<AdminModuleKey, PermissionLayerKey[]>>;
  // Superadmin-only grant: can this account see OTHER users' Last Login Location
  // (Admin Panel -> Users)? Always true for role === 'superadmin'. For role ===
  // 'admin' it's OFF by default and must be explicitly switched on by the
  // Superadmin (PUT /api/users/:id/login-location-access). Irrelevant for 'user'.
  can_view_login_location?: boolean;
  // Superadmin-only grant: can this Admin ALSO set OTHER accounts' Module Access
  // (the module_permissions grant above) themselves, via PUT
  // /api/users/:id/module-permissions? Always false for role !== 'admin'. OFF by
  // default, switched on by the Superadmin (PUT /api/users/:id/feature-permissions
  // with this field — Superadmin-only there too). Deliberately narrower than the
  // Superadmin's own version of this power: a delegated Admin using it can only
  // grant/revoke Module Access for a role === 'user' target, never another
  // 'admin' — enforced server-side, not just hidden in the UI.
  can_grant_module_access?: boolean;
  // Superadmin-only grant: can this Admin ALSO use the User Panel (mark Remote
  // Attendance, submit Claims/Conveyance Bills, enter Job/MPR data) alongside
  // their Admin Panel? OFF by default for role === 'admin', switched on by the
  // Superadmin (PUT /api/users/:id/user-panel-access). Irrelevant for 'user'
  // (already has it by definition) and 'superadmin' (Admin Panel only).
  can_access_user_panel?: boolean;
  // Superadmin-only grant: can this Admin or User account edit OTHER accounts'
  // Leave balances on Self Service -> Leave Management (see LeaveBalance below)?
  // Always true for role === 'superadmin'. OFF by default for 'admin'/'user',
  // switched on by the Superadmin (PUT /api/users/:id/leave-management-access).
  can_manage_leave?: boolean;
  // Superadmin-only grants: can this Admin or User account see/use the Movement
  // Claim (GPS Check In/Out) and Conveyance Bill Claim sections on ITS OWN User
  // Panel at all? Always true for role === 'superadmin'. OFF by default for
  // 'admin'/'user', switched on by the Superadmin (PUT
  // /api/users/:id/movement-claim-access and .../conveyance-claim-access) — the
  // same gate every other module already has, applied here too.
  can_view_movement_claims?: boolean;
  can_view_conveyance_claims?: boolean;
  // Superadmin-only grant: can this Admin or User account see/use the core
  // Budget/Jobs/Job Entry Details workflow ("Select a Budget", "Jobs", "Job
  // Entry Details" — the mobile tile menu, BottomNav tabs, and the
  // Navbar/GlobalSidebar "Jobs" menu's Entry/Jobs/Entry Details items) on ITS
  // OWN User Panel at all? Always true for role === 'superadmin'. Unlike
  // can_view_movement_claims/can_view_conveyance_claims above, this is ON by
  // default for 'admin'/'user' too, so nothing changes until the Superadmin
  // explicitly switches it off (PUT /api/users/:id/budget-module-access).
  can_view_budget_module?: boolean;
  // Admin/Superadmin-granted: shows the Leave Summary card on THIS account's
  // own Dashboard (User Panel) at all. Always true for role === 'superadmin'.
  // OFF by default for 'admin'/'user', switched on per account via PUT
  // /api/users/:id/feature-permissions — same toggle pattern as
  // can_use_attendance above.
  can_view_leave_summary?: boolean;
  // Superadmin-only grants: can this Admin or User account see/use Self
  // Service -> Timesheet / Leave Application / My Leave at all? Always true
  // for role === 'superadmin'. OFF by default for 'admin'/'user', switched on
  // by the Superadmin (PUT /api/users/:id/timesheet-access,
  // .../leave-application-access, .../my-leave-access) — same on/off pattern
  // as can_view_movement_claims/can_view_conveyance_claims above. Self
  // Service -> Employee Directory deliberately has NO such flag — every
  // account keeps seeing it regardless (see GlobalSidebar.tsx).
  can_view_timesheet?: boolean;
  can_view_leave_application?: boolean;
  can_view_my_leave?: boolean;
}

// One custom Leave Category a Leave Manager has defined from Leave Manage ->
// Set Balance in Bulk -> Add Category (GET/POST /api/leave-categories) —
// beyond the fixed Casual/Sick/Leave-without-Pay columns on LeaveBalance
// below. `key` is the stable slug balances are keyed by (both in
// LeaveBalance.custom_leaves and in the bulk PUT's custom_categories body);
// `label` is what's shown on screen.
export interface LeaveCategory {
  id: number;
  key: string;
  label: string;
}

// Per-Leave-Category Policy — Self Service -> Leave Manage -> "Leave
// Policies" (GET/PUT /api/leave-policies). One per Leave Type: the 3 fixed
// LeaveType values ('casual'/'sick'/'without_pay') plus any custom Leave
// Category's key. Enforced server-side in POST /api/leave-applications —
// this is also fetched by NewLeaveApplicationModal so the form itself can
// hide the Reliever picker / show the advance-notice minimum up front,
// matching what the server will actually accept.
export interface LeaveCategoryPolicy {
  category_key: string;
  // Must apply at least this many days before the Leave's Start Date. 0 = no
  // restriction (same-day/retrospective apply allowed).
  min_advance_notice_days: number;
  // Whether a Reliever must be picked for this Leave Type.
  reliever_required: boolean;
  // Longest single application allowed for this Leave Type, in days. null =
  // no cap.
  max_consecutive_days: number | null;
  // Leave Without Pay style rule: this Leave Type may only be applied for
  // once Casual Leave AND Sick Leave balances are both exhausted (0).
  require_paid_leave_exhausted: boolean;
}

// One row of Self Service -> Leave Management (GET/PUT /api/leave-balances). A
// Superadmin or any account with can_manage_leave sees/edits every Admin/User's
// balances; everyone else only ever gets back their own single row.
export interface LeaveBalance {
  user_id: number;
  user_name?: string;
  user_role?: UserRole;
  // From the Employee Directory row linked to this login account
  // (all_employees.user_id) — null if this account has no linked Employee row
  // or that row has no Department set. Lets Leave Management's "Set Balance in
  // Bulk" panel group/filter accounts by Department without its own column.
  department?: string | null;
  casual_leave: number;
  sick_leave: number;
  leave_without_pay: number;
  updated_at?: string | null;
  // This account's balance for each custom Leave Category (see LeaveCategory
  // above) that has ever been set via Set Balance in Bulk. Omitted/empty for
  // accounts with no custom-category balance set yet.
  custom_leaves?: { key: string; label: string; balance: number }[];
}

// Self Service -> Leave Application. The three built-in Leave types —
// same three columns as LeaveBalance above (casual_leave/sick_leave/
// leave_without_pay), just written without the "_leave"/"leave_" padding
// since this is a value, not a balance column name. LeaveApplication.leave_type
// itself is typed as `string` (not LeaveType) below since it can ALSO be a
// custom Leave Category's key (LeaveCategory.key, e.g. "custom_maternity_leave")
// — LeaveType alone still covers the built-in three, e.g. for LEAVE_TYPE_OPTIONS'
// fixed part in NewLeaveApplicationModal.
export type LeaveType = 'casual' | 'sick' | 'without_pay';

// One selectable entry in the New Leave Application's Approver picker — every
// Admin/Superadmin account (see GET /api/leave-applications/approvers).
export interface LeaveApprover {
  id: number;
  name: string;
}

// One row of Self Service -> Leave Application (GET /api/leave-applications/mine,
// POST /api/leave-applications). Submitting one immediately deducts day_count
// from the matching LeaveBalance column server-side — status here is only the
// review label shown on this page, it doesn't gate the deduction.
export interface LeaveApplication {
  id: number;
  user_id: number;
  user_name?: string;
  // Either one of the 3 fixed LeaveType values, or a custom Leave Category's
  // key (LeaveCategory.key) — see the LeaveType comment above. Always use
  // leave_type_label below for display; never assume leave_type itself is a
  // fixed LeaveType when rendering.
  leave_type: string;
  // Server-resolved display label for leave_type — "Casual"/"Sick"/"Leave
  // Without Pay" for the 3 fixed types, or the matching LeaveCategory's label
  // for a custom category (falling back to the raw key if that category was
  // since deleted). Always present on every GET route that returns a
  // LeaveApplication; optional here only so a freshly-POSTed local object
  // (before the list is refetched) doesn't need to fake one.
  leave_type_label?: string;
  start_date: string;
  end_date: string;
  day_count: number;
  is_continuous: boolean;
  is_prefix: boolean;
  is_suffix: boolean;
  is_half_day: boolean;
  include_extra_work_dates: boolean;
  is_foreign_leave: boolean;
  purpose: string;
  approver_id: number;
  approver_name?: string;
  // From the Employee Directory row linked to the applicant's login account
  // (all_employees.user_id) — only ever populated by GET
  // /api/leave-applications/report (the 'leave_applications' module's
  // Department-scoped report); null/absent everywhere else. Same lookup
  // LeaveBalance.department already uses.
  department?: string | null;
  status: 'pending' | 'approved' | 'rejected';
  apply_date: string;
  remarks?: string | null;
  decided_by?: number | null;
  decided_by_name?: string | null;
  decided_at?: string | null;
  created_at?: string;
  current_step?: number | null;
  total_steps?: number | null;
  // Reliever workflow — picked by the applicant at submission (ANY account,
  // required); the request sits waiting on the Reliever's own Approve/Reject
  // BEFORE it ever reaches the Dynamic Approval Engine. See POST
  // /api/leave-applications/:id/reliever-decision.
  reliever_id?: number | null;
  reliever_name?: string | null;
  reliever_status?: 'pending' | 'approved' | 'rejected' | null;
  reliever_remarks?: string | null;
  reliever_decided_at?: string | null;
}

// One row of a Bulk Add Users import (Admin Panel -> Users -> Bulk Add Users).
export interface BulkUserRow {
  sl: number;
  project_name: string;
  password: string;
}

// Per-row result from POST /api/users/bulk.
export interface BulkUserResultItem {
  sl: number;
  project_name: string;
  reason?: string; // present on skipped rows
  id?: number;      // present on created rows
  username?: string; // present on created rows
}

export interface Project {
  id: number;
  project_name: string;
  created_by?: number;
  created_at?: string;
  // Site location pin set from Admin Panel -> Projects -> "Set Location on Map"
  // (free OpenStreetMap/Leaflet picker). All three null until someone marks a spot.
  location_lat?: number | null;
  location_lng?: number | null;
  location_label?: string | null;
  location_radius?: number | null; // meters — optional site-radius circle around the pin
}

// A company Branch (Admin Panel -> Branches, a separate AdminModuleKey from
// Projects). Same shape/purpose as Project — a GPS-pinned site an account can
// be tied to for Remote Attendance — but kept in its own table so Branch rows
// never leak into Project pickers used elsewhere (MPR Entries, Bulk Add Users
// logins, Budget/Job reports), which all read from `projects` specifically.
// Phase 1: Branch management only (this CRUD + the Admin Panel tab). Assigning
// an account to a Branch instead of a Project, and having Remote Attendance /
// Timesheet honor that, is a follow-up phase.
export interface Branch {
  id: number;
  branch_name: string;
  created_by?: number;
  created_at?: string;
  // Site location pin set from Admin Panel -> Branches -> "Set Location on Map"
  // (same free OpenStreetMap/Leaflet picker Projects uses). All three null
  // until someone marks a spot.
  location_lat?: number | null;
  location_lng?: number | null;
  location_label?: string | null;
  location_radius?: number | null; // meters — optional site-radius circle around the pin
}

export interface UserProjectPermission {
  id: number;
  user_id: number;
  project_id: number;
  created_at?: string;
}

export interface MprNumber {
  id: number;
  mpr_no: string;
  created_by?: number;
  created_at?: string;
}

export interface Job {
  id: number;
  job_no: string;
  job_duration: string;
  created_at?: string;
}

export interface Entry {
  id: number;
  entry_date: string;
  job_name: string;
  budget_id?: number | null;
  project_id: number;
  job_id: number;
  mpr_id: number;
  // Exact imported Budget Excel row (budget_items.id) this entry's Item Name was
  // picked from. Null for older entries created before this column existed.
  budget_item_id?: number | null;
  item_name: string;
  // How much of this Item's imported Qty (req_qty below) THIS entry is for — editable
  // by the user, capped server-side against the item's remaining balance for them.
  // Null for older entries created before this column existed.
  requisitioned_qty?: number | string | null;
  delivery_date: string;
  created_by?: number;
  project_name: string;
  job_no: string;
  job_duration: string;
  mpr_no: string;
  user_name?: string;
  budget_name?: string | null;
  created_at?: string;
  // Pulled from the matching imported Budget Excel row (budget_id + MRF No + Description)
  specification?: string | null;
  req_qty?: string | null;
  unit?: string | null;
  bi_sl_no?: string | null;
  bi_req_no?: string | null;
  bi_item_date?: string | null;
  po_qty?: string | null;
  received_qty?: string | null;
  balance_qty?: string | null;
  bi_entry_user?: string | null;
  bi_approved_date?: string | null;
  bi_app_user?: string | null;
  site_sup_date?: string | null;
  // Whether the owning user has already submitted (locked) this entry's Budget
  budget_locked?: boolean;
  // Admin-set allowed Delivery Date window for this entry's Budget (both null = no
  // restriction). Pulled straight off GET /api/entries (joined from budgets) instead
  // of GET /api/budgets, because that second endpoint only returns Budgets an admin
  // has marked is_published for non-admin callers — a locked Job's Budget can be
  // unpublished (or was never published to this user in the first place) and would
  // then silently vanish from that list, leaving Job Edit's date picker unrestricted.
  delivery_date_from?: string | null;
  delivery_date_to?: string | null;
  // "Job Recycle" soft delete — only present on rows returned from the Admin's
  // Recycle bin endpoint (GET /api/entries/recycle); active entries never carry these.
  deleted_at?: string | null;
  deleted_by?: number | null;
  deleted_by_name?: string | null;
  // Set by POST /api/budgets/:id/approve ("Approve & Calculate"), matched from the Rate
  // File. matched_rate/computed_amount null with rate_calculated_at set means it WAS
  // attempted but genuinely found no match (vs. null rate_calculated_at = never run yet).
  matched_rate?: number | null;
  computed_amount?: number | null;
  category_head?: string | null;
  category_sub1?: string | null;
  category_sub2?: string | null;
  category_sub3?: string | null;
  category_sector?: string | null;
  rate_calculated_at?: string | null;
}

export interface EntryEditHistory {
  id: number;
  entry_id: number;
  edited_by?: number | null;
  editor_name?: string | null;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  edited_at: string;
  // Only present on rows returned from the system-wide GET /api/entries/edit-history
  // (the Admin Panel's "MPR Edit Log" tab) — absent from the per-entry history popup.
  job_no?: string | null;
  job_name?: string | null;
  mpr_id?: number | null;
  mpr_no?: string | null;
  item_name?: string | null;
  entry_owner_id?: number | null;
  entry_owner_name?: string | null;
}

// GET /api/entries/permanent-delete-log — Superadmin-only (see AdminPanel.tsx's
// "servers"-style gating). One row per entry ever erased via DELETE
// /api/entries/:id/permanent; every field here is a snapshot taken right before
// that entry row was hard-deleted, not a live join, since the entry itself is
// gone by the time this log is read.
export interface EntryPermanentDeleteLog {
  id: number;
  entry_id: number;
  entry_date: string | null;
  job_name: string | null;
  job_no: string | null;
  project_name: string | null;
  mpr_no: string | null;
  item_name: string | null;
  requisitioned_qty: number | null;
  entry_created_by_name: string | null;
  entry_deleted_by_name: string | null;
  entry_deleted_at: string | null;
  permanently_deleted_by: number | null;
  permanently_deleted_by_name: string;
  permanently_deleted_at: string;
}

// Delivery Date "minimum lead time" condition — Admin Panel -> PEPM Manage ->
// Data Import -> Condition Set (GET/PUT/POST/DELETE /api/delivery-date-conditions...,
// resolver in deliveryDateConditions.ts). One row per (condition_type, scope,
// scope_id): the single Global row (scope 'global', scope_id 0) plus any
// number of Project/Budget override rows. scope_name is only populated for
// override rows (joined project_name/budget_name), so the admin UI can show
// "Project: X" / "Budget: Y" without a second lookup.
export type DeliveryConditionType = 'entry' | 'job_edit';
export type DeliveryConditionScope = 'global' | 'project' | 'budget';
export interface DeliveryDateCondition {
  id: number;
  condition_type: DeliveryConditionType;
  scope: DeliveryConditionScope;
  scope_id: number;
  min_lead_days: number;
  apply_to_admins: number;
  enabled: number;
  scope_name?: string | null;
}

// One row of the Job Edit Approval queue — a "Job Edit" (Add MPR to a Final-
// Submitted Job / Delete an MPR from one) made by a User who only has the
// can_job_edit permission, sitting pending Admin review instead of being applied
// immediately. Returned by GET /api/job-edits/mine (this user's own, scoped to a
// Job) and GET /api/job-edits (Admin Panel -> PEPM Manage -> Edit Log, every
// User's, for the "editlog" module to review/act on via POST /api/job-edits/:id/act).
export interface PendingJobEdit {
  id: number;
  // Null for a still-pending 'add_job' request — there's no real Job yet, only
  // what's proposed in payload below. Set (and joined via job_no) for add_item /
  // delete_entry, and backfilled onto add_job once an Admin approves it.
  job_id: number | null;
  job_no?: string | null;
  job_name?: string | null;
  // Which existing MPR row this request is against — set for 'delete_entry', null
  // for a still-pending 'add_item'/'add_job' (there's no real entries row yet).
  entry_id: number | null;
  action: 'add_item' | 'delete_entry' | 'add_job';
  status: 'pending' | 'approved' | 'rejected';
  // add_item: { mpr_no, mpr_id, budget_item_id, item_name, requisitioned_qty,
  // delivery_date, reason } — the proposed new MPR row, plus the Edit Reason the
  // user gave for adding it.
  // add_job: { budget_id, budget_name, project_id, project_name, job_name,
  // job_duration, reason, items: [{ mpr_no, mpr_id, budget_item_id, item_name,
  // requisitioned_qty, delivery_date }] } — the proposed brand-new Job, with every
  // MPR row it would be created with, plus the Edit Reason.
  // delete_entry: { reason } — the row to delete is entry_id above; entry/mpr_no/
  // item_name/requisitioned_qty/delivery_date below carry its current values for
  // display, joined server-side.
  payload: any;
  entry_mpr_no?: string | null;
  entry_item_name?: string | null;
  entry_requisitioned_qty?: number | null;
  entry_delivery_date?: string | null;
  requested_by?: number;
  requested_by_name?: string | null;
  reviewed_by?: number | null;
  reviewed_by_name?: string | null;
  reviewed_at?: string | null;
  review_note?: string | null;
  created_at: string;
}

export interface Budget {
  id: number;
  budget_name: string;
  created_by?: number;
  created_at?: string;
  item_count?: number;
  original_filename?: string | null;
  has_file?: boolean;
  // Admin-set allowed Delivery Date window for entries created under this Budget
  // (both null/empty = no restriction).
  delivery_date_from?: string | null;
  delivery_date_to?: string | null;
  // Whether the CURRENT logged-in user has already submitted (finished/locked) this
  // Budget — set per-user by the server, not a global flag on the Budget itself.
  submitted?: boolean;
  // Admin's "Submit" gate on the Data Import page: a Budget stays hidden from Users
  // (is_published = false) until the Admin reviews the imported Excel data and submits
  // it. GET /api/budgets already filters unpublished Budgets out for non-admin users,
  // so a User-facing screen will simply never receive one with is_published: false.
  is_published?: boolean;
  published_at?: string | null;
  // Set by POST /api/budgets/:id/approve ("Approve & Calculate") — when an Admin last
  // matched Rate/Category onto every entry under this Budget, and who ran it.
  rate_approved_at?: string | null;
  rate_approved_by?: number | null;
}

// One row of GET /api/budgets/:id/submissions (Admin-only) — a user who has
// Final Submitted this Budget. active_entry_count is how many of their entries
// under it are still active (not soft-deleted); the Admin's "Unlock" button
// (DELETE /api/budgets/:id/submissions/:userId) works whether this is 0 or not.
export interface BudgetSubmission {
  user_id: number;
  user_name: string | null;
  submitted_at: string;
  active_entry_count: number;
}

export interface BudgetItem {
  id: number;
  budget_id: number;
  sl_no?: string;
  project_name?: string;
  req_no?: string;
  mrf_no?: string;
  item_date?: string;
  description?: string;
  unit?: string;
  specification?: string;
  req_qty?: string;
  po_qty?: string;
  received_qty?: string;
  balance_qty?: string;
  entry_user?: string;
  approved_date?: string;
  app_user?: string;
  site_sup_date?: string;
  created_at?: string;
  // How much of this item's req_qty the CALLING user has already put into their own
  // active entries — from GET /api/budgets/:id/items, used to show/cap the remaining
  // Requisitioned Qty available to them for this item.
  requisitioned_by_me?: number | null;
}

// A minimal, system-wide "is this MPR No already used, and under which Job" record —
// from GET /api/entries/mpr-usage. Deliberately has no created_by / user_name so a
// User can see an MPR No is taken (and where) without browsing other users' entries.
export interface MprUsage {
  mpr_id: number;
  mpr_no: string;
  job_no: string;
  job_name: string;
  project_name: string;
  entry_date: string;
  // Whether this usage row belongs to a DIFFERENT user than the caller (never who,
  // just whether). Usage by the calling user themself doesn't block reselecting the
  // MPR No — they may still requisition an Item's remaining Qty balance under it.
  used_by_other?: boolean;
}

// "Remote Attendance" — a User checks in/out for a Project from the User Panel; the
// server only accepts it if the device's GPS coordinates fall inside that Project's
// location_radius circle (see projects.location_lat/lng/radius). One row per
// (user_id, project_id, attendance_date) — check-in and check-out share the same row.
// GET /api/attendance/report/monthly?year=&month=&project_id=&user_id=&department=
// (Admin Panel -> Monthly Attendance Report -> Month Wise, gated by the
// 'attendance_reports' module — separate from the raw 'attendance' log
// module so a Superadmin can grant just the summary report to a role
// without exposing the full log). user_id narrows the `users` array below
// to a single Employee; department narrows it to everyone in that
// Employee Directory department. Both omitted, every User/Admin is returned.
// One row per User covering every calendar day of the requested month.
export interface MonthlyAttendanceReportDay {
  date: string;
  present: boolean;
  check_in_at?: string | null;
  check_out_at?: string | null;
  project_name?: string | null;
  // 'remote' = a real GPS/project check-in row. 'office' = no Remote row existed
  // for this date, so the linked Employee's ZKTeco office punch was used as a
  // fallback instead. null only when present is false (Absent, neither exists).
  source?: 'remote' | 'office' | null;
  // Remote (GPS) Check In/Out remarks — always null on an 'office' (ZKTeco)
  // sourced day, since office punches carry no remarks of their own.
  check_in_remarks?: string | null;
  check_out_remarks?: string | null;
  // Set when this date is on the Global Calendar (Admin Panel -> Holidays) —
  // null on a normal working day. When set, this date never counts toward
  // absent_days below, whether or not the person checked in.
  day_type?: HolidayDayType | null;
  holiday_title?: string | null;
}

export interface MonthlyAttendanceReportRow {
  user_id: number;
  user_name: string;
  user_role: UserRole;
  // From the Employee Directory row linked to this login account
  // (all_employees.user_id) — null if unlinked or that row has no Department
  // set. Same lookup GET /api/leave-balances uses.
  department?: string | null;
  present_days: number;
  complete_days: number;
  // Calendar (Weekend/Holiday) dates this month — excluded from both
  // present_days and absent_days.
  holiday_days: number;
  absent_days: number;
  days: MonthlyAttendanceReportDay[];
}

export interface MonthlyAttendanceReport {
  year: number;
  month: number;
  days_in_month: number;
  users: MonthlyAttendanceReportRow[];
}

// GET /api/attendance/report/daily?date=&project_id=&user_id=&department=
// (Admin Panel -> Monthly Attendance Report -> Date Wise) — every User split
// into who checked in/out that single calendar day vs. who didn't, gated by
// 'attendance_reports'. user_id narrows present/absent/on_holiday to a single
// Employee; department narrows it to everyone in that Employee Directory
// department. Both omitted, every User/Admin account is included.
export interface DailyAttendanceReportPresentRow {
  user_id: number;
  user_name: string;
  // Same Employee Directory lookup as MonthlyAttendanceReportRow.department.
  department?: string | null;
  project_name?: string | null;
  check_in_at?: string | null;
  check_out_at?: string | null;
  check_in_distance_m?: number | null;
  check_out_distance_m?: number | null;
  check_in_remarks?: string | null;
  check_out_remarks?: string | null;
  check_in_approval?: ApprovalStatusSummary | null;
  check_out_approval?: ApprovalStatusSummary | null;
  // 'remote' = a real GPS/project check-in row. 'office' = no Remote row existed
  // for this User on this date, so the linked Employee's ZKTeco office punch
  // was used as a fallback instead (project_name/approvals are always null then).
  source?: 'remote' | 'office';
}

export interface DailyAttendanceReportAbsentRow {
  user_id: number;
  user_name: string;
  department?: string | null;
}

export interface DailyAttendanceReport {
  date: string;
  present: DailyAttendanceReportPresentRow[];
  absent: DailyAttendanceReportAbsentRow[];
  // Same shape as `absent`, but for a date the Global Calendar marks Weekend/
  // Holiday — populated INSTEAD of `absent` on such a date (`absent` is then
  // always []), so nobody who simply didn't check in on a day off gets shown
  // as Absent.
  on_holiday: DailyAttendanceReportAbsentRow[];
  day_type: HolidayDayType | null;
  holiday_title: string | null;
  total_users: number;
}

// Office Attendance (ZKTeco) — one row per employee per day, computed from raw
// zk_attendance_logs punches (first punch = check-in, last = check-out).
// Deliberately separate from AttendanceRecord below: no project/GPS involved,
// and it's keyed to all_employees (the full company roster), not `users`.
export interface OfficeAttendanceRow {
  employee_id: number;
  name: string;
  designation: string | null;
  department: string | null;
  attendance_date: string;
  check_in_at: string | null;
  check_out_at: string | null;
  punch_count: number;
}

export interface AttendanceRecord {
  id: number;
  user_id: number;
  project_id: number;
  attendance_date: string;
  check_in_at?: string | null;
  check_in_lat?: number | null;
  check_in_lng?: number | null;
  // Distance in meters from the Project's pin at the moment of check-in/out —
  // always <= the Project's location_radius at that time, since the server
  // rejects anything further out.
  check_in_distance_m?: number | null;
  // Optional free-text note the User can attach when checking in/out (e.g. why
  // they arrived late) — never required, always trimmed/capped server-side.
  check_in_remarks?: string | null;
  check_out_at?: string | null;
  check_out_lat?: number | null;
  check_out_lng?: number | null;
  check_out_distance_m?: number | null;
  check_out_remarks?: string | null;
  created_at?: string;
  // Only present on rows returned to a User's own history / an Admin's system-wide
  // list (joined server-side) — never trusted as something the client can set.
  project_name?: string;
  location_radius?: number | null;
  user_name?: string;
  // Approval Workflow status for this row's Check In / Check Out (Admin Panel ->
  // Approvals). Null means no Approval Chain was configured yet when that event
  // happened, so there's nothing to show — the check-in/out itself is unaffected
  // either way (the workflow is a non-blocking review trail, not a gate).
  check_in_approval?: ApprovalStatusSummary | null;
  check_out_approval?: ApprovalStatusSummary | null;
  // Set by GET /api/attendance/status only — which source today's effective
  // check_in_at/check_out_at actually came from. 'office' means there was no
  // Remote (GPS) value yet, so the linked Employee's ZKTeco office punch was
  // used as a fallback instead (that field's lat/lng/distance/remarks stay
  // null in that case, since Office Attendance carries no GPS data).
  check_in_source?: 'remote' | 'office' | null;
  check_out_source?: 'remote' | 'office' | null;
}

// A User-submitted request (Self Service -> Timesheet -> click a date's row) to
// manually set that day's In Time/Out Time — typically because the day shows
// Absent (no attendance row exists at all yet), but any day can be corrected.
// Never changes `attendance` directly; only takes effect once Approved (see
// finalizeAttendanceCorrection server-side). Routed through the same global
// Approval Workflow chain as Attendance Check In/Out and Conveyance Bill
// Claims — reuses the existing Admin Panel -> Approvals queue, no separate
// review page.
export interface AttendanceCorrection {
  id: number;
  user_id: number;
  project_id: number;
  attendance_date: string;
  requested_check_in_at?: string | null;
  requested_check_out_at?: string | null;
  // Optional free-text reason for the edit — never required.
  remarks?: string | null;
  file_name?: string | null;
  file_mimetype?: string | null;
  has_file?: boolean;
  status: 'pending' | 'approved' | 'rejected';
  admin_remarks?: string | null;
  reviewed_by?: number | null;
  reviewed_at?: string | null;
  created_at?: string;
  // Only present on rows from GET /api/attendance/corrections/mine (joined
  // server-side) — mirrors ClaimRecord/UserClaim's `approval` field, null
  // meaning no chain was configured yet when this request was submitted (in
  // which case it was auto-processed immediately instead).
  approval?: AttendanceCorrectionApproval | null;
}
// (source: 'user_claim' once it reaches a ConveyanceBillItem) that requires
// Admin approval before it's attached to an official Conveyance Bill. Unlike a
// Movement Claim (ClaimRecord — a live GPS check-in/out) this is filled in by
// hand after the fact, optionally spanning several days (a multi-day tour) and
// optionally carrying a receipt/attachment. See POST /api/user-claims.
export type UserClaimCategory = 'Transport' | 'Fuel' | 'Toll' | 'Parking' | 'Others';
export type UserClaimStatus = 'pending' | 'approved' | 'rejected';

export const USER_CLAIM_CATEGORIES: UserClaimCategory[] = ['Transport', 'Fuel', 'Toll', 'Parking', 'Others'];

// One referenced Movement Claim (check-in/out) attached to a UserClaim, each
// carrying its own Amount — see user_claim_references / GET /api/claims/available.
// purpose/check_in_at/check_out_at/distance_km are joined in from the `claims`
// row for display, so the User/Admin can see exactly which check-in/out an
// amount belongs to without a second lookup.
export interface UserClaimReference {
  claim_id: number;
  amount: number;
  purpose: string;
  check_in_at: string;
  check_out_at?: string | null;
  distance_km?: number | null;
  // Where the referenced Movement Claim's Check In/Out actually happened — lets
  // an Admin open the same read-only ClaimLocationMap while reviewing a
  // Conveyance Bill Claim, without a second permission-gated lookup.
  check_in_lat?: number | null;
  check_in_lng?: number | null;
  check_out_lat?: number | null;
  check_out_lng?: number | null;
  check_in_approval?: ApprovalStatusSummary | null;
  check_out_approval?: ApprovalStatusSummary | null;
}

export interface UserClaim {
  id: number;
  user_id: number;
  claim_date: string; // YYYY-MM-DD
  from_date: string; // YYYY-MM-DD — start of the covered date range (defaults to claim_date)
  to_date: string; // YYYY-MM-DD — end of the covered date range, >= from_date
  category: UserClaimCategory;
  // The total Claim Amount. Whenever claim_refs is non-empty this is always the
  // SUM of those rows' amounts (computed server-side on submit); otherwise it's
  // the User's own free-typed figure.
  amount: number;
  // Zero or more completed Movement Claims (check-in/out) this claim references,
  // each with its own amount — see POST /api/user-claims (claim_refs in the
  // request body) and GET /api/claims/available (the picker source). A given
  // check-in/out can only ever be referenced by ONE UserClaim.
  claim_refs?: UserClaimReference[];
  description?: string | null;
  // The attachment itself (LONGBLOB) is never sent on list/mine/admin-list rows —
  // only has_file (whether one exists) is. Fetch the actual bytes from
  // GET /api/user-claims/:id/file, which the owner or an Admin with the
  // "conveyance" module can call.
  file_name?: string | null;
  file_mimetype?: string | null;
  has_file?: boolean;
  status: UserClaimStatus;
  // Set by the Admin on Approve/Reject — shown to the User on a Rejected claim,
  // optional on Approved.
  admin_remarks?: string | null;
  reviewed_by?: number | null;
  reviewed_by_name?: string | null;
  reviewed_at?: string | null;
  // Set once an Approved claim has actually been attached as a line item onto a
  // Conveyance Bill (see POST /api/user-claims/:id/decision) — null until then.
  bill_item_id?: number | null;
  bill_id?: number | null;
  created_at?: string;
  updated_at?: string;
  // Only present on rows from the Admin's GET /api/user-claims list.
  user_name?: string | null;
  // Present once this claim was routed through the Approval Workflow (a
  // Template/Supervisor applied at submit time) — null when either no
  // Approval Request exists yet (auto-processed immediately, nothing
  // configured) or the claim predates this feature. Includes which Layer/
  // approver it's currently sitting with (while still 'pending') and its
  // approve/reject trail so far. See attachUserClaimApproval server-side.
  approval?: UserClaimApproval | null;
}

// Same idea as AttendanceCorrectionApproval — adds who a Conveyance Bill
// Claim's Approval Request is currently sitting with (null once it's no
// longer 'pending') and the full approve/reject trail, so the User can see
// exactly which Layer their claim is waiting on.
export interface UserClaimApproval extends ApprovalStatusSummary {
  current_approver_name?: string | null;
  actions?: ApprovalAction[];
}

// A recipient option for the Notice "Specific Users" target picker — from
// GET /api/notices/recipients (every plain 'user' account only).
export interface NoticeRecipient {
  id: number;
  name: string;
  email: string | null;
  username: string | null;
}

// Superadmin/Admin -> User popup shown right after the User logs in. content_html
// is free-form text/HTML the Admin composes; lottie_json (pasted animation JSON)
// or lottie_url (a hosted .json link) optionally shows a custom animation above it
// — if both are set, lottie_json wins. target_type 'all' reaches every plain
// 'user' account; 'specific' only the users listed in target_user_ids.
export interface Notice {
  id: number;
  title: string;
  content_html: string;
  lottie_json?: string | null;
  lottie_url?: string | null;
  target_type: 'all' | 'specific';
  is_active: boolean;
  created_by?: number | null;
  created_by_name?: string | null;
  created_at?: string;
  updated_at?: string;
  // Only present on rows returned from the Admin's GET /api/notices list.
  target_user_ids?: number[];
  target_users?: { id: number; name: string }[];
}

// Personal Alerts (bell icon, web + mobile) — a small per-account inbox.
// `type` stays a plain string on the server (not a DB enum) so more kinds can
// be added later without a migration; 'leave_application' is the first one
// wired up (Leave Application Approve/Reject notifies the applicant).
export type AlertType = 'leave_application';

export interface Alert {
  id: number;
  user_id: number;
  type: AlertType;
  title: string;
  message: string;
  related_type?: string | null;
  related_id?: number | null;
  is_read: boolean;
  created_at: string;
}

// One notice as delivered to a logged-in User by GET /api/notices/active —
// deliberately missing target_type/is_active/created_by, which are only the
// Admin's business.
export interface ActiveNotice {
  id: number;
  title: string;
  content_html: string;
  lottie_json?: string | null;
  lottie_url?: string | null;
  created_at?: string;
}

// "Movement Claim" — a User checks in with a Purpose (where/why they're heading
// out for office work), then later checks out once they reach/finish there. Unlike
// Remote Attendance this isn't tied to a fixed Project geofence — it's a free-form
// point A -> point B travel record used for TA/DA-style reimbursement claims. Only
// ONE claim may be 'open' (checked in, not yet checked out) per User at a time —
// see POST /api/claims/check-in. distance_km is computed server-side (straight-line)
// once check-out coordinates come in.
export interface ClaimRecord {
  id: number;
  user_id: number;
  purpose: string;
  status: 'open' | 'completed';
  check_in_at: string;
  check_in_lat: number;
  check_in_lng: number;
  check_in_remarks?: string | null;
  check_out_at?: string | null;
  check_out_lat?: number | null;
  check_out_lng?: number | null;
  check_out_remarks?: string | null;
  // Straight-line (haversine) distance between check-in and check-out points, in
  // kilometers — null until check-out happens.
  distance_km?: number | null;
  created_at?: string;
  // Approval Workflow status for this claim's Check In / Check Out (Admin Panel ->
  // Approvals) — null means no Approval Chain was configured yet when that event
  // happened. Non-blocking review trail, not a gate on the claim itself.
  check_in_approval?: ApprovalStatusSummary | null;
  check_out_approval?: ApprovalStatusSummary | null;
  // Only present on rows returned to an Admin's system-wide list (joined server-side).
  user_name?: string | null;
}

// One line item inside a Conveyance Bill (Admin Panel -> Conveyance Bill Claim,
// Superadmin + explicitly-granted Admins only) — either pulled in from that
// Bill's User's own completed Movement Claim (source: 'movement_claim', claim_id
// set) or entered fully by hand (source: 'manual', claim_id null). Every field
// here is this item's OWN copy, taken from the Claim at the moment it was added
// (if any) — it stays intact even if that Claim is later edited/removed.
export interface ConveyanceBillItem {
  id: number;
  bill_id: number;
  source: 'movement_claim' | 'manual' | 'user_claim';
  claim_id?: number | null;
  // Set when source === 'user_claim' — which User-submitted claim this item was
  // approved in from (see UserClaim above). Mutually exclusive with claim_id.
  user_claim_id?: number | null;
  entry_date: string;
  particulars: string;
  from_location?: string | null;
  to_location?: string | null;
  // Straight-line distance in km, if this item is distance-based (movement_claim
  // items always have one; a manual item may or may not).
  distance_km?: number | null;
  // Rate applied per km to reach `amount` — null if `amount` was entered/overridden
  // directly instead of being computed from distance_km * rate_per_km.
  rate_per_km?: number | null;
  amount: number;
  remarks?: string | null;
  created_at?: string;
}

// One Conveyance Bill — groups several ConveyanceBillItem rows for a single User
// into one claim document. See GET /api/conveyance-bills/:id for the shape that
// includes `items`.
export interface ConveyanceBill {
  id: number;
  user_id: number;
  bill_date: string;
  remarks?: string | null;
  created_by?: number | null;
  created_at?: string;
  updated_at?: string;
  // Only present on rows returned from the Admin's GET /api/conveyance-bills* routes.
  user_name?: string | null;
  item_count?: number;
  total_amount?: number;
  items?: ConveyanceBillItem[];
  // Set once this Bill has been paid out (Admin Panel -> Conveyance Disbursement,
  // Superadmin + explicitly-granted Admins only — see ADMIN_MODULES/'disbursement').
  // A Bill is otherwise just a claim document; disbursement is the separate
  // "money actually handed over" step, recorded here so it isn't re-paid by
  // mistake and so a Payment Voucher can be reprinted later with the same
  // voucher_no. See POST /api/conveyance-bills/:id/disburse and .../undisburse.
  is_disbursed?: boolean;
  voucher_no?: string | null;
  disbursed_at?: string | null;
  disbursed_by?: number | null;
  disbursed_by_name?: string | null;
}

// Fired by the Navbar's web-only "Claims" header menu (Movement Claims /
// Conveyance Bill Claim) — App.tsx bumps `ts` on every click (even repeat
// clicks on the same target) so AdminPanel/UserPanel's effect always re-fires,
// then hands this down to whichever of the two panels is currently mounted.
export interface ClaimsNavRequest {
  target: 'movementClaims' | 'conveyanceBill';
  ts: number;
}

// Fired by the Navbar's web-only "Budget", "Manage" and "Workforce" header
// menus — same bump-`ts`-on-every-click pattern as ClaimsNavRequest above.
// Consumed by AdminPanel only: every one of these targets is an Admin-only
// tab with no User Panel equivalent, unlike Movement Claims/Conveyance Bill
// Claim above which exist in both panels.
export interface AdminNavRequest {
  // 'my_conveyance' is NOT an AdminModuleKey/module_permissions entry — it's
  // the "My Conveyance Bill Claim" sub-view (an Admin's own Bills/Claims,
  // read-only), shown alongside the 'conveyance' tab to anyone who already
  // has that module, not a separately-grantable permission of its own.
  // 'servers' is likewise NOT an AdminModuleKey/module_permissions entry —
  // it's the Superadmin-only "Servers" catalog tab (see ServerProfileRoutes.ts),
  // never grantable to an Admin/User the way every other Admin Panel module is.
  // 'permanent_delete_log' is the same — Superadmin-only, see
  // GET /api/entries/permanent-delete-log in EntriesRoutes.ts.
  target: 'dashboard' | 'reports' | 'mprs' | 'imports' | 'editlog' | 'recycle' | 'projects' | 'branches' | 'users' | 'notices' | 'approvals' | 'attendance' | 'attendance_reports' | 'employees' | 'departments' | 'tracking' | 'holidays' | 'disbursement' | 'my_conveyance' | 'asset_management' | 'servers' | 'permanent_delete_log';
  ts: number;
}

// Fired by the Navbar's web-only "Jobs" header menu (Entry / Jobs / Entry
// Details / Job Edits) — same bump-`ts`-on-every-click pattern as
// ClaimsNavRequest above. Consumed by UserPanel only: every one of these
// targets is a User Panel section with no Admin Panel equivalent, unlike
// Movement Claims/Conveyance Bill Claim which exist in both panels.
export interface JobsNavRequest {
  target: 'entry' | 'jobs' | 'entryDetails' | 'jobEdit';
  ts: number;
}

// Fired by GlobalSidebar's "Dashboard" item (and any other "go back to the
// User Panel dashboard" action) — same bump-`ts`-on-every-click pattern as
// ClaimsNavRequest above. Consumed by UserPanel only: clears its own
// persisted mobileActiveSection/desktopActiveSection (see UserPanel.tsx) so
// the dashboard/tile menu actually comes back on screen, instead of App.tsx
// only switching viewMode to 'user' while UserPanel keeps showing whichever
// section (e.g. a Claims page) was left active/persisted from before.
export interface DashboardNavRequest {
  ts: number;
}

// Chat (Direct/Group/Community messaging) — see ChatRoutes.ts for the
// server-side data model these mirror.
export interface ChatDirectoryUser {
  id: number;
  name: string;
  email: string | null;
  username?: string | null;
  role: UserRole;
}

export interface ChatRoom {
  id: number;
  type: 'direct' | 'group' | 'community';
  title: string | null;
  parent_room_id: number | null;
  created_by: number | null;
  has_avatar: boolean;
  my_role: 'admin' | 'member';
  last_message_id: number | null;
  last_message_content: string | null;
  last_message_type: 'text' | 'image' | 'file' | 'audio' | null;
  last_message_sender_id: number | null;
  last_message_at: string | null;
  unread_count: number;
  // Only set for type === 'direct' — the other participant, so the room list
  // can show their name/avatar instead of a room title (direct chats have none).
  other_participant: ChatDirectoryUser | null;
}

export interface ChatRoomMember {
  user_id: number;
  name: string;
  email: string | null;
  username?: string | null;
  role: 'admin' | 'member';
  joined_at: string;
}

// GET /api/chat/messages/:id/reads response row — used for the group "Seen
// by ..." caption under your own most recent message (ChatPanel.tsx).
export interface ChatReadReceipt {
  id: number;
  name: string;
  read_at: string;
}

export interface ChatMessage {
  id: number;
  room_id: number;
  sender_id: number;
  sender_name: string;
  message_type: 'text' | 'image' | 'file' | 'audio';
  content: string | null;
  attachment_filename: string | null;
  attachment_mimetype: string | null;
  has_attachment: boolean;
  reply_to_id: number | null;
  reply_to_content: string | null;
  reply_to_sender_name: string | null;
  created_at: string;
}