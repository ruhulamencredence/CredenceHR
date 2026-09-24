// Boolean-typed extended employee fields (see EMPLOYEE_EXT_FIELDS in server.ts), needed
// here to coerce all_employees insert/update params to 0/1 in the memory-DB simulation.
export const EMPLOYEE_BOOL_FIELDS = ["is_foreigner"] as const;

// In-Memory Fallback DB storage when MySQL is not running (no demo data — admin is seeded from .env at startup)
export const memoryDb = {
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
  adminModulePermissionLayers: [] as any[],
  attendance: [] as any[],
  location_pings: [] as any[],
  notices: [] as any[],
  noticeTargets: [] as any[],
  noticeDismissals: [] as any[],
  employees: [] as any[],
  employeeSupervisors: [] as any[],
  employeePaymentAccounts: [] as any[],
  payrollPaymentSplits: [] as any[],
  assets: [] as any[],
  assetRequisitions: [] as any[],
  assetRequisitionItems: [] as any[],
  assetAssignments: [] as any[],
  assetAssignmentClaims: [] as any[],
  claims: [] as any[],
  approvalChainSteps: [] as any[],
  approvalRequests: [] as any[],
  approvalTemplates: [] as any[],
  approvalTemplateSteps: [] as any[],
  approvalTemplateStepApprovers: [] as any[],
  employeeTemplateAssignments: [] as any[],
  leaveBalances: [] as any[],
  leaveApplications: [] as any[],
  leaveCategories: [] as any[],
  leaveCategoryBalances: [] as any[],
  // Seeded to match the ('casual',0,1,NULL,0) etc. seed INSERT IGNORE in
  // server.ts's ensureSchemaMigrations, so in-memory dev behaves the same as
  // a fresh real-DB install: Reliever always required, no other restriction.
  leaveCategoryPolicies: [
    { category_key: "casual", min_advance_notice_days: 0, reliever_required: 1, max_consecutive_days: null, require_paid_leave_exhausted: 0 },
    { category_key: "sick", min_advance_notice_days: 0, reliever_required: 1, max_consecutive_days: null, require_paid_leave_exhausted: 0 },
    { category_key: "without_pay", min_advance_notice_days: 0, reliever_required: 1, max_consecutive_days: null, require_paid_leave_exhausted: 0 },
    { category_key: "custom_earn_leave", min_advance_notice_days: 0, reliever_required: 0, max_consecutive_days: null, require_paid_leave_exhausted: 0 }
  ] as any[],
  // Earn Leave — seeded to match the INSERT IGNORE INTO leave_categories
  // ('custom_earn_leave', 'Earn Leave', NULL) seed in server.ts, so it shows
  // up in Set Balance in Bulk/Leave Policies/the Leave Type dropdown in
  // in-memory dev mode exactly like a fresh real-DB install.
  leaveYearSettings: null as any,
  leaveBalanceWorkflows: [
    { id: 1, name: "General", scope_type: "general", designation: null, is_active: 1, created_by: null, created_at: new Date() }
  ] as any[],
  leaveBalanceWorkflowItems: [] as any[],

  // Exit/Offboarding + Full & Final Settlement, Performance Management,
  // Recruitment/ATS, Grievance & Disciplinary, Document Vault — all simple
  // CRUD tables handled generically by simulateGenericTable() below rather
  // than bespoke per-query handlers (see that function's own comment).
  exitRequests: [] as any[],
  exitClearanceItems: [] as any[],
  // Branches (Admin Panel -> Branches) — never had ANY memory-fallback
  // support before (the table itself had no self-healing migration either,
  // until now — see the branches CREATE TABLE comment in server.ts).
  branches: [] as any[],
  // Holiday Calendar (Admin Panel -> Holidays) — head_office/project_site
  // split, see holidayRoutes.ts. All routes there fetch the whole table and
  // filter in JS rather than relying on WHERE/BETWEEN in SQL, so the plain
  // generic-table handlers below (full SELECT *, id-based UPDATE/DELETE,
  // fully-parameterized INSERT) are enough — no bespoke handler needed.
  holidayCalendar: [] as any[],
  // Pre-seeded the same way ensureExitOffboardingSchema's INSERT IGNORE does
  // against real MySQL — the 4 fixed clearance departments, all starting
  // unassigned, so ExitOffboardingPanel's "Clearance Approvers" dropdowns
  // have something to render in dev/in-memory mode too.
  exitClearanceApprovers: [
    { id: 1, department: "IT", approver_user_id: null },
    { id: 2, department: "Finance", approver_user_id: null },
    { id: 3, department: "Admin", approver_user_id: null },
    { id: 4, department: "HR", approver_user_id: null }
  ] as any[],
  finalSettlements: [] as any[],
  performanceCycles: [] as any[],
  performanceGoals: [] as any[],
  performanceReviews: [] as any[],
  jobPostings: [] as any[],
  jobCandidates: [] as any[],
  candidateInterviews: [] as any[],
  grievances: [] as any[],
  disciplinaryActions: [] as any[],
  employeeDocuments: [] as any[],
  documentSignatures: [] as any[],
  // Chat/Alerts push notification device tokens (ChatRoutes.ts's POST/DELETE
  // /api/chat/push-token, PushNotificationService.ts's sendPushToUserIds/
  // sendPushToRoomMembers) — was missing a handler entirely, so in
  // memory-fallback mode every push-token INSERT/SELECT silently no-opped:
  // registration "succeeded" (200 OK) but nothing was ever actually stored,
  // and every push send read back zero tokens and sent nothing. See the
  // explicit handlers below (not simulateGenericTable — this table's INSERT
  // is an upsert with ON DUPLICATE KEY UPDATE, and its SELECTs use IN(...)/
  // a JOIN, neither of which the generic simulator understands).
  chatPushTokens: [] as any[]
};

// Generic simple-table CRUD simulator, used by every module below that has
// no exotic query shapes — INSERT INTO t (cols...) VALUES (...), UPDATE t SET
// col = ?, ... WHERE id = ?, DELETE FROM t WHERE id = ?, SELECT * FROM t
// WHERE id = ?, and SELECT * FROM t (any other/no WHERE clause just returns
// every row — those routes always filter/sort in JS afterwards instead of
// relying on a real WHERE, the same trick GET /api/leave-balances etc. above
// already lean on for all_employees, so this single generic path covers
// every query those route files actually send). Saves writing ~10 bespoke
// handlers per table the way the tables above needed.
function simulateGenericTable(table: string, store: any[], sql: string, lowerSql: string, params: any[]): any {
  if (lowerSql.startsWith(`insert into ${table}`)) {
    const colsMatch = sql.match(/\(([^)]+)\)\s*values/i);
    const cols = colsMatch ? colsMatch[1].split(",").map((c) => c.trim()) : [];
    const newId = store.length ? Math.max(...store.map((r: any) => Number(r.id))) + 1 : 1;
    const row: any = { id: newId, created_at: new Date() };
    cols.forEach((col, i) => {
      row[col] = params[i] !== undefined ? params[i] : null;
    });
    store.push(row);
    return { insertId: newId };
  }
  if (lowerSql.startsWith(`update ${table} set`)) {
    // 's' (dotAll) flag: several of this codebase's UPDATE statements are
    // multi-line template literals (e.g. ExitOffboardingRoutes.ts's
    // settlement update), and a plain `.` never matches `\n` — without it
    // this silently captures nothing past the first line break, updating
    // zero columns instead of throwing, which is much harder to notice.
    const setMatch = sql.match(/set\s+(.+?)\s+where/is);
    const cols = setMatch ? setMatch[1].split(",").map((c) => c.trim().split("=")[0].trim()) : [];
    const id = Number(params[params.length - 1]);
    const row = store.find((r: any) => Number(r.id) === id);
    if (row) {
      cols.forEach((col, i) => {
        row[col] = params[i] !== undefined ? params[i] : null;
      });
      row.updated_at = new Date();
    }
    return { affectedRows: row ? 1 : 0 };
  }
  if (lowerSql.startsWith(`delete from ${table} where id`)) {
    const id = Number(params[0]);
    const before = store.length;
    const kept = store.filter((r: any) => Number(r.id) !== id);
    store.length = 0;
    store.push(...kept);
    return { affectedRows: before - store.length };
  }
  if (lowerSql.startsWith(`select * from ${table} where id`)) {
    const id = Number(params[0]);
    return store.filter((r: any) => Number(r.id) === id);
  }
  if (lowerSql.startsWith(`select * from ${table}`)) {
    return [...store];
  }
  return undefined;
}

// Every table simulateGenericTable() above covers, mapped to its memoryDb
// array — checked in order right before queryMemoryDb's final `return []`
// fallback, so any bespoke handler already matched earlier in the function
// (none needed yet, but a future exception could still be added above this
// point) always takes priority.
const GENERIC_TABLES: [string, any[]][] = [
  ["exit_clearance_items", memoryDb.exitClearanceItems],
  ["exit_clearance_approvers", memoryDb.exitClearanceApprovers],
  ["exit_requests", memoryDb.exitRequests],
  ["branches", memoryDb.branches],
  ["holiday_calendar", memoryDb.holidayCalendar],
  ["final_settlements", memoryDb.finalSettlements],
  ["performance_cycles", memoryDb.performanceCycles],
  ["performance_goals", memoryDb.performanceGoals],
  ["performance_reviews", memoryDb.performanceReviews],
  ["job_postings", memoryDb.jobPostings],
  ["job_candidates", memoryDb.jobCandidates],
  ["candidate_interviews", memoryDb.candidateInterviews],
  ["grievances", memoryDb.grievances],
  ["disciplinary_actions", memoryDb.disciplinaryActions],
  ["employee_documents", memoryDb.employeeDocuments],
  ["document_signatures", memoryDb.documentSignatures],
  ["approval_templates", memoryDb.approvalTemplates],
  ["approval_template_step_approvers", memoryDb.approvalTemplateStepApprovers],
  ["approval_template_steps", memoryDb.approvalTemplateSteps]
];
memoryDb.leaveCategories = [{ id: 1, category_key: "custom_earn_leave", label: "Earn Leave", created_by: null, created_at: new Date() }];

// SQL-string pattern-matching simulator for the in-memory fallback DB, used by queryDB()
// in server.ts when MySQL is unavailable (local preview/testing without XAMPP running).
export function queryMemoryDb(sql: string, params: any[] = []): any {
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
      can_view_leave_summary: !!u.can_view_leave_summary,
      can_view_timesheet: !!u.can_view_timesheet,
      can_view_leave_application: !!u.can_view_leave_application,
      can_view_my_leave: !!u.can_view_my_leave,
      can_grant_module_access: !!u.can_grant_module_access,
      attendance_project_id: u.attendance_project_id ?? null
    }));
  }
  // GET /api/auth/me's own SELECT — matched on a short, stable prefix (not the
  // full column list) since that real query has grown extra columns over time
  // (can_use_tracking, can_view_budget_module, ... can_grant_module_access) and a
  // full-literal match silently stopped matching and fell through to the [] catch-
  // all below, making /api/auth/me 404 under the in-memory DB. This prefix is
  // unique to this query — GET /api/users' own SELECT (handled above) has
  // "username" as its 4th column instead of "role", so it can never collide here.
  if (lowerSql.startsWith("select id, name, email, role, created_at, can_edit_delivery_date")) {
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
      can_view_leave_summary: rest.can_view_leave_summary ? 1 : 0,
      can_view_timesheet: rest.can_view_timesheet ? 1 : 0,
      can_view_leave_application: rest.can_view_leave_application ? 1 : 0,
      can_view_my_leave: rest.can_view_my_leave ? 1 : 0,
      can_grant_module_access: rest.can_grant_module_access ? 1 : 0,
      attendance_project_id: rest.attendance_project_id ?? null
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
  if (lowerSql.startsWith("select can_view_timesheet from users where id")) {
    const id = Number(params[0]);
    const user = memoryDb.users.find(u => u.id === id);
    if (!user) return [];
    return [{ can_view_timesheet: user.can_view_timesheet ? 1 : 0 }];
  }
  if (lowerSql.startsWith("select can_view_leave_application from users where id")) {
    const id = Number(params[0]);
    const user = memoryDb.users.find(u => u.id === id);
    if (!user) return [];
    return [{ can_view_leave_application: user.can_view_leave_application ? 1 : 0 }];
  }
  if (lowerSql.startsWith("select can_view_my_leave from users where id")) {
    const id = Number(params[0]);
    const user = memoryDb.users.find(u => u.id === id);
    if (!user) return [];
    return [{ can_view_my_leave: user.can_view_my_leave ? 1 : 0 }];
  }
  if (lowerSql.startsWith("select attendance_project_id from users where id")) {
    const id = Number(params[0]);
    const user = memoryDb.users.find(u => u.id === id);
    if (!user) return [];
    return [{ attendance_project_id: user.attendance_project_id ?? null }];
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
  // requireModuleGrantAccess's own fresh-from-DB check (server.ts) — the JWT
  // payload doesn't carry this flag, so it's always read live here.
  if (lowerSql.startsWith("select can_grant_module_access from users")) {
    const id = Number(params[0]);
    const user = memoryDb.users.find(u => u.id === id);
    return user ? [{ can_grant_module_access: user.can_grant_module_access ? 1 : 0 }] : [];
  }
  // PUT /api/users/:id/feature-permissions' own pre-flight lookup (role + every
  // field it can update) — was entirely unhandled, so this endpoint always 404'd
  // ("User not found") under the in-memory DB, for every one of these toggles.
  if (lowerSql.startsWith("select role, can_edit_delivery_date, can_job_edit, can_use_attendance, can_use_tracking, can_view_leave_summary, attendance_project_id from users")) {
    const id = Number(params[0]);
    const user = memoryDb.users.find(u => u.id === id);
    if (!user) return [];
    return [{
      role: user.role,
      can_edit_delivery_date: user.can_edit_delivery_date !== false ? 1 : 0,
      can_job_edit: user.can_job_edit ? 1 : 0,
      can_use_attendance: user.can_use_attendance ? 1 : 0,
      can_use_tracking: user.can_use_tracking ? 1 : 0,
      can_view_leave_summary: user.can_view_leave_summary ? 1 : 0,
      attendance_project_id: user.attendance_project_id ?? null
    }];
  }
  if (lowerSql.startsWith("update users set can_edit_delivery_date")) {
    const [can_edit_delivery_date, can_job_edit, can_use_attendance, can_use_tracking, can_view_leave_summary, attendance_project_id, id] = params;
    const user = memoryDb.users.find(u => u.id === Number(id));
    if (user) {
      user.can_edit_delivery_date = !!Number(can_edit_delivery_date);
      user.can_job_edit = !!Number(can_job_edit);
      user.can_use_attendance = !!Number(can_use_attendance);
      user.can_use_tracking = !!Number(can_use_tracking);
      user.can_view_leave_summary = !!Number(can_view_leave_summary);
      user.attendance_project_id = attendance_project_id === null ? null : Number(attendance_project_id);
    }
    return { affectedRows: user ? 1 : 0 };
  }
  // Superadmin-only "Grants Module Access" toggle — matched BEFORE the bulk
  // can_edit_delivery_date/... UPDATE above would otherwise need to (it doesn't
  // collide since that one starts with "can_edit_delivery_date", not
  // "can_grant_module_access", but this is its own separate UPDATE statement —
  // see PUT /api/users/:id/feature-permissions in UserManagement.ts).
  if (lowerSql.startsWith("update users set can_grant_module_access")) {
    const [can_grant_module_access, id] = params;
    const user = memoryDb.users.find(u => u.id === Number(id));
    if (user) user.can_grant_module_access = !!Number(can_grant_module_access);
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
  if (lowerSql.startsWith("update users set can_view_timesheet")) {
    const [can_view_timesheet, id] = params;
    const user = memoryDb.users.find(u => u.id === Number(id));
    if (user) user.can_view_timesheet = !!Number(can_view_timesheet);
    return { affectedRows: user ? 1 : 0 };
  }
  if (lowerSql.startsWith("update users set can_view_leave_application")) {
    const [can_view_leave_application, id] = params;
    const user = memoryDb.users.find(u => u.id === Number(id));
    if (user) user.can_view_leave_application = !!Number(can_view_leave_application);
    return { affectedRows: user ? 1 : 0 };
  }
  if (lowerSql.startsWith("update users set can_view_my_leave")) {
    const [can_view_my_leave, id] = params;
    const user = memoryDb.users.find(u => u.id === Number(id));
    if (user) user.can_view_my_leave = !!Number(can_view_my_leave);
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

  // ADMIN MODULE PERMISSION LAYERS (Superadmin -> per-module Read Only/Edit-
  // Add/Entry-Upload/Delete-Trash/Permanent Delete, layered on top of the
  // grant above)
  if (lowerSql.startsWith("select layer_key from admin_module_permission_layers where user_id")) {
    const [userId, moduleKey] = params;
    return memoryDb.adminModulePermissionLayers
      .filter((r: any) => r.user_id === Number(userId) && r.module_key === moduleKey)
      .map((r: any) => ({ layer_key: r.layer_key }));
  }
  if (lowerSql.startsWith("select module_key, layer_key from admin_module_permission_layers where user_id")) {
    const userId = Number(params[0]);
    return memoryDb.adminModulePermissionLayers
      .filter((r: any) => r.user_id === userId)
      .map((r: any) => ({ module_key: r.module_key, layer_key: r.layer_key }));
  }
  if (lowerSql.startsWith("select user_id, module_key, layer_key from admin_module_permission_layers")) {
    return memoryDb.adminModulePermissionLayers.map((r: any) => ({ user_id: r.user_id, module_key: r.module_key, layer_key: r.layer_key }));
  }
  if (lowerSql.startsWith("delete from admin_module_permission_layers where user_id")) {
    // Two shapes share this prefix: "...WHERE user_id = ?" alone (role
    // demote — wipe every module's layers for this account) and "...WHERE
    // user_id = ? AND module_key = ?" (Module Access save — wipe just one
    // module's layers). Distinguished by param count, not text, since one
    // query string is a prefix of the other.
    const userId = Number(params[0]);
    if (params.length >= 2) {
      const moduleKey = params[1];
      memoryDb.adminModulePermissionLayers = memoryDb.adminModulePermissionLayers.filter(
        (r: any) => !(r.user_id === userId && r.module_key === moduleKey)
      );
    } else {
      memoryDb.adminModulePermissionLayers = memoryDb.adminModulePermissionLayers.filter((r: any) => r.user_id !== userId);
    }
    return { affectedRows: 1 };
  }
  if (lowerSql.startsWith("insert into admin_module_permission_layers")) {
    const [userId, moduleKey, layerKey] = params;
    memoryDb.adminModulePermissionLayers.push({ user_id: Number(userId), module_key: moduleKey, layer_key: layerKey });
    return { insertId: memoryDb.adminModulePermissionLayers.length };
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
  // Admin "Submissions" panel — everyone who's Final Submitted this Budget, with
  // their name and how many active entries they still have under it.
  if (lowerSql.startsWith("select bs.user_id, bs.submitted_at, u.name as user_name")) {
    const budget_id = params[0];
    return memoryDb.budget_submissions
      .filter((s: any) => s.budget_id === budget_id)
      .map((s: any) => {
        const u = memoryDb.users.find((usr: any) => usr.id === s.user_id);
        const active_entry_count = memoryDb.entries.filter(
          (e: any) => e.budget_id === s.budget_id && e.created_by === s.user_id && !e.deleted_at
        ).length;
        return {
          user_id: s.user_id,
          submitted_at: s.submitted_at,
          user_name: u ? u.name : null,
          active_entry_count
        };
      })
      .sort((a: any, b: any) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());
  }
  if (lowerSql.startsWith("insert into budget_submissions")) {
    const [budget_id, user_id] = params;
    const existing = memoryDb.budget_submissions.find(s => s.budget_id === budget_id && s.user_id === user_id);
    if (existing) return { insertId: existing.id };
    const newId = memoryDb.budget_submissions.length + 1;
    memoryDb.budget_submissions.push({ id: newId, budget_id, user_id, submitted_at: new Date() });
    return { insertId: newId };
  }
  // Single-user unlock (auto-unlock on last-entry delete, and the Admin's manual
  // "Unlock Submission" button) — must be matched BEFORE the whole-budget wipe
  // below, since that one's prefix would otherwise swallow this query too.
  if (lowerSql.startsWith("delete from budget_submissions where budget_id") && lowerSql.includes("user_id")) {
    const [budget_id, user_id] = params;
    const before = memoryDb.budget_submissions.length;
    memoryDb.budget_submissions = memoryDb.budget_submissions.filter(
      s => !(s.budget_id === budget_id && s.user_id === user_id)
    );
    return { affectedRows: before - memoryDb.budget_submissions.length };
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
  // Auto-unlock check (EntriesRoutes.ts unlockBudgetSubmissionIfEmpty) — same
  // budget_id+created_by shape as the generic check below, but scoped to ACTIVE
  // entries only, so it must be matched first.
  if (
    lowerSql.startsWith("select id from entries where budget_id") &&
    lowerSql.includes("created_by") &&
    lowerSql.includes("deleted_at is null")
  ) {
    const [budget_id, created_by] = params;
    return memoryDb.entries.filter(
      e => e.budget_id === budget_id && e.created_by === created_by && !e.deleted_at
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
  // the restore / permanent-delete routes, and the delete_entry Job Edit request
  // approval lookup (SELECT id, deleted_at, budget_id FROM entries WHERE id = ?),
  // which additionally needs budget_id for the auto-unlock check.
  if (
    lowerSql.startsWith("select id, deleted_at from entries where id") ||
    lowerSql.startsWith("select id, deleted_at, budget_id from entries where id")
  ) {
    const id = Number(params[0]);
    const e = memoryDb.entries.find((en: any) => en.id === id);
    return e ? [{ id: e.id, deleted_at: e.deleted_at || null, budget_id: e.budget_id ?? null }] : [];
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

  // EMPLOYEE PAYMENT ACCOUNTS (Admin Panel -> Employees -> Edit -> Payment
  // tab) — Bank/MFS disbursement split, read by Run Payroll's
  // buildPaymentSplit (PayrollRoutes.ts) via the same "WHERE employee_id"
  // shape with an extra "AND is_active = 1" it adds itself, distinguished
  // below by lowerSql.includes rather than a second handler.
  if (lowerSql.startsWith("select * from employee_payment_accounts where employee_id")) {
    const employeeId = Number(params[0]);
    let rows = memoryDb.employeePaymentAccounts.filter((r: any) => Number(r.employee_id) === employeeId);
    if (lowerSql.includes("is_active = 1")) rows = rows.filter((r: any) => Number(r.is_active) === 1);
    return [...rows].sort((a: any, b: any) => Number(a.sort_order) - Number(b.sort_order) || a.id - b.id);
  }
  if (lowerSql.startsWith("select percentage from employee_payment_accounts where employee_id")) {
    const employeeId = Number(params[0]);
    return memoryDb.employeePaymentAccounts
      .filter((r: any) => Number(r.employee_id) === employeeId && Number(r.is_active) === 1)
      .map((r: any) => ({ percentage: r.percentage }));
  }
  if (lowerSql.startsWith("select id, percentage from employee_payment_accounts where employee_id")) {
    const employeeId = Number(params[0]);
    const excludeId = Number(params[1]);
    return memoryDb.employeePaymentAccounts
      .filter((r: any) => Number(r.employee_id) === employeeId && Number(r.is_active) === 1 && Number(r.id) !== excludeId)
      .map((r: any) => ({ id: r.id, percentage: r.percentage }));
  }
  if (lowerSql.startsWith("select * from employee_payment_accounts where id")) {
    const rowId = Number(params[0]);
    const employeeId = Number(params[1]);
    return memoryDb.employeePaymentAccounts.filter((r: any) => Number(r.id) === rowId && Number(r.employee_id) === employeeId);
  }
  if (lowerSql.startsWith("select id from employee_payment_accounts where id")) {
    const rowId = Number(params[0]);
    const employeeId = Number(params[1]);
    return memoryDb.employeePaymentAccounts
      .filter((r: any) => Number(r.id) === rowId && Number(r.employee_id) === employeeId)
      .map((r: any) => ({ id: r.id }));
  }
  if (lowerSql.startsWith("insert into employee_payment_accounts")) {
    // is_active is a literal `1` in this INSERT's SQL text (not a `?`
    // placeholder — see the route comment), so it's deliberately NOT among
    // the destructured params below; sort_order is the 9th and last one.
    const [employeeId, accountType, accountLabel, bankName, branchName, provider, accountNumber, percentage, sortOrder] = params;
    const newId = memoryDb.employeePaymentAccounts.length ? Math.max(...memoryDb.employeePaymentAccounts.map((r: any) => r.id)) + 1 : 1;
    memoryDb.employeePaymentAccounts.push({
      id: newId,
      employee_id: Number(employeeId),
      account_type: accountType,
      account_label: accountLabel,
      bank_name: bankName ?? null,
      branch_name: branchName ?? null,
      provider: provider ?? null,
      account_number: accountNumber,
      percentage: Number(percentage),
      is_active: 1,
      sort_order: Number(sortOrder),
      created_at: new Date()
    });
    return { insertId: newId };
  }
  // NOT "...accounts set" — the route's UPDATE is a multi-line template
  // literal with a newline between the table name and SET, so lowerSql
  // never actually contains that exact substring (see memoryDbFallback.ts's
  // approval_template_step_approvers handler for this same pitfall).
  if (lowerSql.startsWith("update employee_payment_accounts")) {
    const [accountType, accountLabel, bankName, branchName, provider, accountNumber, percentage, isActive, rowId] = params;
    const row = memoryDb.employeePaymentAccounts.find((r: any) => Number(r.id) === Number(rowId));
    if (row) {
      row.account_type = accountType;
      row.account_label = accountLabel;
      row.bank_name = bankName ?? null;
      row.branch_name = branchName ?? null;
      row.provider = provider ?? null;
      row.account_number = accountNumber;
      row.percentage = Number(percentage);
      row.is_active = isActive ? 1 : 0;
      row.updated_at = new Date();
    }
    return { affectedRows: row ? 1 : 0 };
  }
  if (lowerSql.startsWith("delete from employee_payment_accounts")) {
    const rowId = Number(params[0]);
    const before = memoryDb.employeePaymentAccounts.length;
    memoryDb.employeePaymentAccounts = memoryDb.employeePaymentAccounts.filter((r: any) => Number(r.id) !== rowId);
    return { affectedRows: before - memoryDb.employeePaymentAccounts.length };
  }

  // PAYROLL PAYMENT SPLITS — the per-payroll-row snapshot of the accounts
  // above, taken at generation time (see PayrollRoutes.ts's generate-bulk).
  if (lowerSql.startsWith("insert into payroll_payment_splits")) {
    const [payrollId, accountType, accountLabel, bankName, branchName, provider, accountNumber, percentage, amount] = params;
    const newId = memoryDb.payrollPaymentSplits.length ? Math.max(...memoryDb.payrollPaymentSplits.map((r: any) => r.id)) + 1 : 1;
    memoryDb.payrollPaymentSplits.push({
      id: newId,
      payroll_id: Number(payrollId),
      account_type: accountType,
      account_label: accountLabel,
      bank_name: bankName ?? null,
      branch_name: branchName ?? null,
      provider: provider ?? null,
      account_number: accountNumber,
      percentage: Number(percentage),
      amount: Number(amount),
      created_at: new Date()
    });
    return { insertId: newId };
  }
  if (lowerSql.startsWith("select * from payroll_payment_splits where payroll_id")) {
    const payrollId = Number(params[0]);
    return memoryDb.payrollPaymentSplits.filter((r: any) => Number(r.payroll_id) === payrollId);
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

  // Dynamic Approval Engine TEMPLATES (ApprovalRoutes.ts's Template CRUD +
  // Employee<->Template Assignment, and server.ts's resolveApprovalTemplate/
  // createTemplateApprovalRequest) — every JOIN/GROUP BY/non-id-WHERE query
  // these use, handled by hand here; plain id-keyed SELECT/UPDATE/DELETE and
  // fully-parameterized INSERTs on approval_templates/approval_template_steps/
  // approval_template_step_approvers fall through to simulateGenericTable via
  // GENERIC_TABLES below instead (those three are registered there).
  if (lowerSql.startsWith("select * from approval_template_steps where template_id")) {
    const templateId = Number(params[0]);
    return memoryDb.approvalTemplateSteps
      .filter((s: any) => Number(s.template_id) === templateId)
      .sort((a: any, b: any) => a.step_order - b.step_order);
  }
  if (lowerSql.startsWith("select sa.*, u.name as user_name")) {
    const templateId = Number(params[0]);
    const stepIds = new Set(
      memoryDb.approvalTemplateSteps.filter((s: any) => Number(s.template_id) === templateId).map((s: any) => Number(s.id))
    );
    return memoryDb.approvalTemplateStepApprovers
      .filter((a: any) => stepIds.has(Number(a.step_id)))
      .sort((a: any, b: any) => a.id - b.id)
      .map((a: any) => {
        const u = memoryDb.users.find((x: any) => Number(x.id) === Number(a.user_id));
        return { id: a.id, step_id: a.step_id, user_id: a.user_id, user_name: u ? u.name : null };
      });
  }
  // GET /api/approvals' own templateStepApproversMap fetch (ApprovalRoutes.ts)
  // — every step-approver row, system-wide, joined up to its template_id/
  // step_order (no WHERE at all, unlike the two handlers above/below it that
  // scope to one template or one step).
  if (lowerSql.startsWith("select s.template_id, s.step_order, sa.user_id, u.name as user_name")) {
    return memoryDb.approvalTemplateStepApprovers.map((a: any) => {
      const s = memoryDb.approvalTemplateSteps.find((x: any) => Number(x.id) === Number(a.step_id));
      const u = memoryDb.users.find((x: any) => Number(x.id) === Number(a.user_id));
      return {
        template_id: s ? s.template_id : null,
        step_order: s ? s.step_order : null,
        user_id: a.user_id,
        user_name: u ? u.name : null
      };
    });
  }
  // getCurrentStepApprovers (server.ts) — the authorization-critical lookup
  // performApprovalAction uses to decide who may act on a Template-driven
  // request's CURRENT step. WHERE-scoped to one (template_id, step_order),
  // unlike the two handlers above.
  if (lowerSql.startsWith("select sa.user_id, u.name as user_name")) {
    const [templateId, stepOrder] = params.map((p: any) => Number(p));
    const stepIds = new Set(
      memoryDb.approvalTemplateSteps
        .filter((s: any) => Number(s.template_id) === templateId && Number(s.step_order) === stepOrder)
        .map((s: any) => Number(s.id))
    );
    return memoryDb.approvalTemplateStepApprovers
      .filter((a: any) => stepIds.has(Number(a.step_id)))
      .map((a: any) => {
        const u = memoryDb.users.find((x: any) => Number(x.id) === Number(a.user_id));
        return { user_id: a.user_id, user_name: u ? u.name : null };
      });
  }
  if (lowerSql.startsWith("select * from approval_templates where request_type")) {
    const requestType = params[0];
    return [...memoryDb.approvalTemplates]
      .filter((t: any) => t.request_type === requestType)
      .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  }
  if (lowerSql.startsWith("select template_id, count(*) as cnt from approval_template_steps group by template_id")) {
    const counts = new Map<number, number>();
    for (const s of memoryDb.approvalTemplateSteps) {
      const tid = Number(s.template_id);
      counts.set(tid, (counts.get(tid) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([template_id, cnt]) => ({ template_id, cnt }));
  }
  if (lowerSql.startsWith("update approval_templates set is_default = 0 where request_type")) {
    const requestType = params[0];
    // Two callers share this prefix: POST/`/default` (just request_type) and
    // PUT (request_type + "AND id <> ?" to exclude the template being saved).
    const excludeId = lowerSql.includes("id <>") ? Number(params[1]) : null;
    for (const t of memoryDb.approvalTemplates) {
      if (t.request_type === requestType && (excludeId === null || Number(t.id) !== excludeId)) {
        t.is_default = 0;
      }
    }
    return { affectedRows: 1 };
  }
  if (lowerSql.startsWith("delete from approval_template_steps where template_id")) {
    const templateId = Number(params[0]);
    const stepIds = new Set(
      memoryDb.approvalTemplateSteps.filter((s: any) => Number(s.template_id) === templateId).map((s: any) => Number(s.id))
    );
    // Mutate the arrays in place (length = 0 + push back the survivors)
    // rather than reassigning memoryDb.approvalTemplateSteps/
    // approvalTemplateStepApprovers to a new array — GENERIC_TABLES captured
    // the ORIGINAL array objects by reference at module load, so a plain `=`
    // here would silently orphan them: later INSERTs via simulateGenericTable
    // would keep pushing into the abandoned array while every SELECT reads
    // the (now permanently empty-of-new-rows) property instead.
    const keptApprovers = memoryDb.approvalTemplateStepApprovers.filter((a: any) => !stepIds.has(Number(a.step_id)));
    memoryDb.approvalTemplateStepApprovers.length = 0;
    memoryDb.approvalTemplateStepApprovers.push(...keptApprovers);
    const before = memoryDb.approvalTemplateSteps.length;
    const keptSteps = memoryDb.approvalTemplateSteps.filter((s: any) => Number(s.template_id) !== templateId);
    memoryDb.approvalTemplateSteps.length = 0;
    memoryDb.approvalTemplateSteps.push(...keptSteps);
    return { affectedRows: before - memoryDb.approvalTemplateSteps.length };
  }
  if (lowerSql.startsWith("select count(*) as cnt from employee_template_assignments where template_id")) {
    const templateId = Number(params[0]);
    const cnt = memoryDb.employeeTemplateAssignments.filter((a: any) => Number(a.template_id) === templateId).length;
    return [{ cnt }];
  }
  if (lowerSql.startsWith("select eta.employee_user_id, eta.template_id, t.name as template_name")) {
    const requestType = params[0];
    return memoryDb.employeeTemplateAssignments
      .filter((a: any) => a.request_type === requestType)
      .map((a: any) => {
        const t = memoryDb.approvalTemplates.find((x: any) => Number(x.id) === Number(a.template_id));
        return { employee_user_id: a.employee_user_id, template_id: a.template_id, template_name: t ? t.name : null };
      });
  }
  if (lowerSql.startsWith("select id, name from approval_templates where request_type")) {
    const requestType = params[0];
    const def = memoryDb.approvalTemplates.find((t: any) => t.request_type === requestType && Number(t.is_default) === 1);
    return def ? [{ id: def.id, name: def.name }] : [];
  }
  if (lowerSql.startsWith("delete from employee_template_assignments where employee_user_id")) {
    const [employeeUserId, requestType] = params;
    const before = memoryDb.employeeTemplateAssignments.length;
    memoryDb.employeeTemplateAssignments = memoryDb.employeeTemplateAssignments.filter(
      (a: any) => !(Number(a.employee_user_id) === Number(employeeUserId) && a.request_type === requestType)
    );
    return { affectedRows: before - memoryDb.employeeTemplateAssignments.length };
  }
  if (lowerSql.startsWith("insert into employee_template_assignments")) {
    const [employeeUserId, requestType, templateId, assignedBy] = params;
    const existing = memoryDb.employeeTemplateAssignments.find(
      (a: any) => Number(a.employee_user_id) === Number(employeeUserId) && a.request_type === requestType
    );
    if (existing) {
      existing.template_id = Number(templateId);
      existing.assigned_by = assignedBy === null || assignedBy === undefined ? null : Number(assignedBy);
      existing.updated_at = new Date();
      return { insertId: existing.id };
    }
    const newId = memoryDb.employeeTemplateAssignments.length
      ? Math.max(...memoryDb.employeeTemplateAssignments.map((a: any) => Number(a.id))) + 1
      : 1;
    memoryDb.employeeTemplateAssignments.push({
      id: newId,
      employee_user_id: Number(employeeUserId),
      request_type: requestType,
      template_id: Number(templateId),
      assigned_by: assignedBy === null || assignedBy === undefined ? null : Number(assignedBy),
      created_at: new Date(),
      updated_at: new Date()
    });
    return { insertId: newId };
  }
  // resolveApprovalTemplate's employee-assignment lookup (server.ts) —
  // employee_template_assignments JOIN approval_templates, filtered down to
  // this employee/request_type's currently-active template, if any.
  if (lowerSql.startsWith("select t.* from employee_template_assignments eta")) {
    const [employeeUserId, requestType] = params;
    const assignment = memoryDb.employeeTemplateAssignments.find(
      (a: any) => Number(a.employee_user_id) === Number(employeeUserId) && a.request_type === requestType
    );
    if (!assignment) return [];
    const t = memoryDb.approvalTemplates.find((x: any) => Number(x.id) === Number(assignment.template_id) && Number(x.is_active) === 1);
    return t ? [t] : [];
  }

  // LEAVE BALANCES (Self Service -> Leave Management)
  if (lowerSql.startsWith("select id, name, role from users where role in")) {
    return memoryDb.users
      .filter((u: any) => u.role === "admin" || u.role === "user")
      .map((u: any) => ({ id: u.id, name: u.name, role: u.role }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
  }
  // Leave Balance Workflows' applyAllActiveWorkflows() — every login account a
  // workflow can possibly target.
  if (lowerSql.startsWith("select id from users where role in")) {
    return memoryDb.users.filter((u: any) => u.role === "admin" || u.role === "user").map((u: any) => ({ id: u.id }));
  }
  // Leave Year auto-rollover's "who applies the workflows" acting account.
  if (lowerSql.startsWith("select id from users where role = 'superadmin'")) {
    return memoryDb.users.filter((u: any) => u.role === "superadmin").slice(0, 1).map((u: any) => ({ id: u.id }));
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

  // CUSTOM LEAVE CATEGORIES (Leave Manage -> Set Balance in Bulk -> Add Category)
  if (lowerSql.startsWith("select id, category_key, label from leave_categories where category_key")) {
    const key = params[0];
    return memoryDb.leaveCategories.filter((c: any) => c.category_key === key);
  }
  if (lowerSql.startsWith("select id, category_key, label from leave_categories")) {
    return [...memoryDb.leaveCategories]
      .map((c: any) => ({ id: c.id, category_key: c.category_key, label: c.label }))
      .sort((a: any, b: any) => String(a.label).localeCompare(String(b.label)));
  }
  if (lowerSql.startsWith("insert into leave_categories")) {
    const [categoryKey, label, createdBy] = params;
    const newId = memoryDb.leaveCategories.length > 0 ? Math.max(...memoryDb.leaveCategories.map((c: any) => c.id)) + 1 : 1;
    memoryDb.leaveCategories.push({
      id: newId,
      category_key: categoryKey,
      label,
      created_by: createdBy ?? null,
      created_at: new Date()
    });
    return { insertId: newId };
  }
  if (lowerSql.startsWith("select * from leave_category_balances where user_id")) {
    const userId = Number(params[0]);
    return memoryDb.leaveCategoryBalances.filter((b: any) => b.user_id === userId);
  }
  if (lowerSql.startsWith("select * from leave_category_balances")) {
    return [...memoryDb.leaveCategoryBalances];
  }
  if (lowerSql.startsWith("insert into leave_category_balances")) {
    const [userId, categoryId, balance] = params;
    const existing = memoryDb.leaveCategoryBalances.find(
      (b: any) => b.user_id === Number(userId) && b.category_id === Number(categoryId)
    );
    if (existing) {
      existing.balance = Number(balance);
      existing.updated_at = new Date();
      return { affectedRows: 1 };
    }
    const newId =
      memoryDb.leaveCategoryBalances.length > 0 ? Math.max(...memoryDb.leaveCategoryBalances.map((b: any) => b.id)) + 1 : 1;
    memoryDb.leaveCategoryBalances.push({
      id: newId,
      user_id: Number(userId),
      category_id: Number(categoryId),
      balance: Number(balance),
      updated_at: new Date()
    });
    return { insertId: newId };
  }
  if (lowerSql.startsWith("select category_key from leave_categories")) {
    return memoryDb.leaveCategories.map((c: any) => ({ category_key: c.category_key }));
  }

  // PER-LEAVE-CATEGORY POLICY (Leave Manage -> "Leave Policies")
  if (lowerSql.startsWith("select * from leave_category_policies where category_key")) {
    const key = params[0];
    return memoryDb.leaveCategoryPolicies.filter((p: any) => p.category_key === key);
  }
  if (lowerSql.startsWith("insert into leave_category_policies")) {
    const [categoryKey, minAdvanceNoticeDays, relieverRequired, maxConsecutiveDays, requirePaidLeaveExhausted, updatedBy] = params;
    const existing = memoryDb.leaveCategoryPolicies.find((p: any) => p.category_key === categoryKey);
    if (existing) {
      existing.min_advance_notice_days = Number(minAdvanceNoticeDays);
      existing.reliever_required = relieverRequired ? 1 : 0;
      existing.max_consecutive_days = maxConsecutiveDays === null || maxConsecutiveDays === undefined ? null : Number(maxConsecutiveDays);
      existing.require_paid_leave_exhausted = requirePaidLeaveExhausted ? 1 : 0;
      existing.updated_by = updatedBy ?? null;
      return { affectedRows: 1 };
    }
    memoryDb.leaveCategoryPolicies.push({
      category_key: categoryKey,
      min_advance_notice_days: Number(minAdvanceNoticeDays),
      reliever_required: relieverRequired ? 1 : 0,
      max_consecutive_days: maxConsecutiveDays === null || maxConsecutiveDays === undefined ? null : Number(maxConsecutiveDays),
      require_paid_leave_exhausted: requirePaidLeaveExhausted ? 1 : 0,
      updated_by: updatedBy ?? null
    });
    return { insertId: memoryDb.leaveCategoryPolicies.length };
  }

  // LEAVE YEAR SETTINGS (Leave Manage -> "Year Settings")
  if (lowerSql.startsWith("select * from leave_year_settings")) {
    return memoryDb.leaveYearSettings ? [memoryDb.leaveYearSettings] : [];
  }
  if (lowerSql.startsWith("insert ignore into leave_year_settings")) {
    if (!memoryDb.leaveYearSettings) {
      const [id, closeMonthDay, startMonthDay, autoRollover] = params;
      memoryDb.leaveYearSettings = {
        id, close_month_day: closeMonthDay, start_month_day: startMonthDay,
        auto_rollover: autoRollover ? 1 : 0, last_rollover_year: null, updated_by: null
      };
    }
    return { affectedRows: 1 };
  }
  if (lowerSql.startsWith("insert into leave_year_settings")) {
    const [closeMonthDay, startMonthDay, autoRollover, updatedBy] = params;
    memoryDb.leaveYearSettings = {
      id: 1, close_month_day: closeMonthDay, start_month_day: startMonthDay,
      auto_rollover: autoRollover ? 1 : 0,
      last_rollover_year: memoryDb.leaveYearSettings?.last_rollover_year ?? null,
      updated_by: updatedBy ?? null
    };
    return { affectedRows: 1 };
  }
  if (lowerSql.startsWith("update leave_year_settings set last_rollover_year")) {
    if (memoryDb.leaveYearSettings) memoryDb.leaveYearSettings.last_rollover_year = params[0];
    return { affectedRows: memoryDb.leaveYearSettings ? 1 : 0 };
  }

  // LEAVE BALANCE WORKFLOWS (Leave Manage -> "Leave Balance Workflows")
  if (lowerSql.startsWith("select * from leave_balance_workflows where id") && lowerSql.includes("and is_active")) {
    const id = Number(params[0]);
    return memoryDb.leaveBalanceWorkflows.filter((w: any) => w.id === id && Number(w.is_active) === 1);
  }
  if (lowerSql.startsWith("select * from leave_balance_workflows where id")) {
    const id = Number(params[0]);
    return memoryDb.leaveBalanceWorkflows.filter((w: any) => w.id === id);
  }
  if (lowerSql.startsWith("select * from leave_balance_workflows where is_active")) {
    return memoryDb.leaveBalanceWorkflows.filter((w: any) => Number(w.is_active) === 1);
  }
  if (lowerSql.startsWith("select * from leave_balance_workflows")) {
    return [...memoryDb.leaveBalanceWorkflows];
  }
  if (
    lowerSql.startsWith(
      "select id from leave_balance_workflows where scope_type = 'designation' and lower(designation) = lower(?) and id"
    )
  ) {
    const [designation, excludeId] = params;
    return memoryDb.leaveBalanceWorkflows.filter(
      (w: any) =>
        w.scope_type === "designation" &&
        String(w.designation || "").toLowerCase() === String(designation).toLowerCase() &&
        w.id !== Number(excludeId)
    );
  }
  if (lowerSql.startsWith("select id from leave_balance_workflows where scope_type = 'designation' and lower(designation)")) {
    const [designation] = params;
    return memoryDb.leaveBalanceWorkflows.filter(
      (w: any) => w.scope_type === "designation" && String(w.designation || "").toLowerCase() === String(designation).toLowerCase()
    );
  }
  if (lowerSql.startsWith("insert ignore into leave_balance_workflows")) {
    if (!memoryDb.leaveBalanceWorkflows.some((w: any) => w.id === 1)) {
      memoryDb.leaveBalanceWorkflows.push({
        id: 1, name: "General", scope_type: "general", designation: null, is_active: 1, created_by: null, created_at: new Date()
      });
    }
    return { affectedRows: 1 };
  }
  if (lowerSql.startsWith("insert into leave_balance_workflows")) {
    const [name, designation, createdBy] = params;
    const newId = memoryDb.leaveBalanceWorkflows.length ? Math.max(...memoryDb.leaveBalanceWorkflows.map((w: any) => w.id)) + 1 : 1;
    memoryDb.leaveBalanceWorkflows.push({
      id: newId, name, scope_type: "designation", designation, is_active: 1, created_by: createdBy, created_at: new Date()
    });
    return { insertId: newId };
  }
  if (lowerSql.startsWith("update leave_balance_workflows set name")) {
    const [name, id] = params;
    const row = memoryDb.leaveBalanceWorkflows.find((w: any) => w.id === Number(id));
    if (row) row.name = name;
    return { affectedRows: row ? 1 : 0 };
  }
  if (lowerSql.startsWith("update leave_balance_workflows set designation")) {
    const [designation, id] = params;
    const row = memoryDb.leaveBalanceWorkflows.find((w: any) => w.id === Number(id));
    if (row) row.designation = designation;
    return { affectedRows: row ? 1 : 0 };
  }
  if (lowerSql.startsWith("update leave_balance_workflows set is_active")) {
    const [isActive, id] = params;
    const row = memoryDb.leaveBalanceWorkflows.find((w: any) => w.id === Number(id));
    if (row) row.is_active = isActive ? 1 : 0;
    return { affectedRows: row ? 1 : 0 };
  }
  if (lowerSql.startsWith("delete from leave_balance_workflows where id")) {
    const id = Number(params[0]);
    memoryDb.leaveBalanceWorkflows = memoryDb.leaveBalanceWorkflows.filter((w: any) => w.id !== id);
    memoryDb.leaveBalanceWorkflowItems = memoryDb.leaveBalanceWorkflowItems.filter((it: any) => it.workflow_id !== id);
    return { affectedRows: 1 };
  }

  // LEAVE BALANCE WORKFLOW ITEMS
  if (lowerSql.startsWith("select * from leave_balance_workflow_items where workflow_id")) {
    const workflowId = Number(params[0]);
    return memoryDb.leaveBalanceWorkflowItems.filter((it: any) => it.workflow_id === workflowId);
  }
  if (lowerSql.startsWith("select * from leave_balance_workflow_items")) {
    return [...memoryDb.leaveBalanceWorkflowItems];
  }
  if (lowerSql.startsWith("delete from leave_balance_workflow_items where workflow_id")) {
    const workflowId = Number(params[0]);
    memoryDb.leaveBalanceWorkflowItems = memoryDb.leaveBalanceWorkflowItems.filter((it: any) => it.workflow_id !== workflowId);
    return { affectedRows: 1 };
  }
  if (lowerSql.startsWith("insert into leave_balance_workflow_items")) {
    const [workflowId, categoryKey, balanceDays] = params;
    const newId = memoryDb.leaveBalanceWorkflowItems.length
      ? Math.max(...memoryDb.leaveBalanceWorkflowItems.map((it: any) => it.id)) + 1
      : 1;
    memoryDb.leaveBalanceWorkflowItems.push({ id: newId, workflow_id: workflowId, category_key: categoryKey, balance_days: balanceDays });
    return { insertId: newId };
  }

  // Employee Directory distinct Designations (Leave Balance Workflows' "new Designation workflow" picker)
  if (lowerSql.startsWith("select distinct designation from all_employees")) {
    const set = new Set<string>();
    for (const e of memoryDb.employees) {
      if (e.designation && String(e.designation).trim()) set.add(String(e.designation).trim());
    }
    return Array.from(set).map((designation) => ({ designation }));
  }

  if (lowerSql.startsWith("select curdate() as today")) {
    return [{ today: new Date().toISOString().slice(0, 10) }];
  }

  // LEAVE APPLICATIONS (Self Service -> Leave Application)
  if (lowerSql.startsWith("select id, name from users where role in ('admin','superadmin')")) {
    return memoryDb.users
      .filter((u: any) => u.role === "admin" || u.role === "superadmin")
      .map((u: any) => ({ id: u.id, name: u.name }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
  }
  // Reliever existence check in POST /api/leave-applications ("SELECT id,
  // name FROM users WHERE id = ?") — checked before the "!=" variant below
  // since both share the same prefix up to "where id ".
  if (lowerSql.startsWith("select id, name from users where id = ?")) {
    const id = Number(params[0]);
    return memoryDb.users.filter((u: any) => u.id === id).map((u: any) => ({ id: u.id, name: u.name }));
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
      isHalfDay, includeExtraWorkDates, isForeignLeave, purpose, relieverId, relieverStatus
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
      reliever_id: relieverId === null || relieverId === undefined ? null : Number(relieverId),
      reliever_status: relieverStatus ?? null,
      reliever_remarks: null,
      reliever_decided_by: null,
      reliever_decided_at: null,
      created_at: new Date()
    });
    return { insertId: newId };
  }
  if (lowerSql.startsWith("select la.*, u.name as approver_name, rv.name as reliever_name")) {
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
  // finalizeLeaveApplicationApproval / rejectLeaveApplicationRecord in
  // server.ts hardcode the target status as a literal ('approved'/'rejected')
  // rather than a `?` placeholder, so they only ever pass 3 params (remarks,
  // decided_by, id) — checked before the older 4-param "status = ?" decision
  // route below (same startsWith prefix otherwise, so the more specific
  // literal match must win first).
  if (lowerSql.startsWith("update leave_applications set status = 'approved'")) {
    const [remarks, decidedBy, id] = params;
    const row = memoryDb.leaveApplications.find((a: any) => a.id === Number(id));
    if (row) {
      row.status = "approved";
      row.remarks = remarks;
      row.decided_by = decidedBy != null ? Number(decidedBy) : null;
      row.decided_at = new Date();
    }
    return { affectedRows: row ? 1 : 0 };
  }
  if (lowerSql.startsWith("update leave_applications set status = 'rejected'")) {
    const [remarks, decidedBy, id] = params;
    const row = memoryDb.leaveApplications.find((a: any) => a.id === Number(id));
    if (row) {
      row.status = "rejected";
      row.remarks = remarks;
      row.decided_by = decidedBy != null ? Number(decidedBy) : null;
      row.decided_at = new Date();
    }
    return { affectedRows: row ? 1 : 0 };
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

  // "give me every user row" fallback for the HR Advanced modules
  // (Exit/Offboarding, Performance, Recruitment, Grievance, Analytics,
  // Document Vault) — each reads whichever of id/name/role it needs off a
  // plain, WHERE-less `SELECT id, name FROM users` or `SELECT * FROM
  // users`, always filtered/joined in JS afterwards. Deliberately narrow
  // (exact, WHERE-less prefixes only) rather than "any select mentioning
  // users" — a broader match would also swallow unrelated queries with
  // their own real WHERE clause (e.g. UserManagement.ts's duplicate-email
  // check, `SELECT id FROM users WHERE email = ?`), silently returning
  // every user instead of an empty/filtered result and breaking THEIR
  // logic instead of just leaving it at the pre-existing "no handler ->
  // empty array" fallback.
  if (
    lowerSql === "select id, name from users" ||
    lowerSql === "select * from users" ||
    lowerSql === "select id, name, email, role from users"
  ) {
    return [...memoryDb.users];
  }
  // Template Assignment screen's employee list (GET /api/template-assignments) —
  // same "every user, filtered/joined in JS afterwards" shape as the fallback
  // just above, just with its own exact column list + ORDER BY.
  if (lowerSql === "select id, name, email, username, role from users order by name asc") {
    return [...memoryDb.users].sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  }

  // Chat/Alerts push notification device tokens (see memoryDb.chatPushTokens
  // above for why this needs its own handler instead of the generic one).
  if (lowerSql.includes("chat_push_tokens")) {
    if (lowerSql.startsWith("insert into chat_push_tokens")) {
      const [userId, token, platform] = params;
      const existing = memoryDb.chatPushTokens.find((t: any) => t.token === token);
      if (existing) {
        existing.user_id = Number(userId);
        existing.platform = platform;
      } else {
        memoryDb.chatPushTokens.push({ id: memoryDb.chatPushTokens.length + 1, user_id: Number(userId), token, platform });
      }
      return { affectedRows: 1 };
    }
    if (lowerSql.startsWith("delete from chat_push_tokens")) {
      if (lowerSql.includes("token in (")) {
        // Dead-token cleanup after a failed push send (see
        // PushNotificationService.ts) — params is the list of dead tokens.
        memoryDb.chatPushTokens = memoryDb.chatPushTokens.filter((t: any) => !params.includes(t.token));
        return { affectedRows: 1 };
      }
      const [token, userId] = params;
      const before = memoryDb.chatPushTokens.length;
      memoryDb.chatPushTokens = memoryDb.chatPushTokens.filter((t: any) => !(t.token === token && t.user_id === Number(userId)));
      return { affectedRows: before - memoryDb.chatPushTokens.length };
    }
    if (lowerSql.startsWith("select") && lowerSql.includes("where user_id in")) {
      // sendPushToUserIds (PushNotificationService.ts) — a plain user_id
      // IN (?, ?, ...) list, no JOIN.
      const ids = params.map((p: any) => Number(p));
      return memoryDb.chatPushTokens.filter((t: any) => ids.includes(t.user_id)).map((t: any) => ({ token: t.token }));
    }
    if (lowerSql.startsWith("select") && lowerSql.includes("join chat_room_members")) {
      // sendPushToRoomMembers — Chat itself has no memory-fallback storage
      // for chat_rooms/chat_room_members yet, so this always reads back
      // empty (pre-existing gap, unrelated to Alerts push).
      return [];
    }
  }

  // Asset Management (AssetManagementRoutes.ts) — bespoke, not GENERIC_TABLES,
  // since almost every query here filters on a non-id column, JOINs, or uses
  // a literal (not `?`) value inside SET/WHERE (e.g. "status = 'assigned'"),
  // none of which simulateGenericTable's 4 shapes understand. Matched on a
  // short prefix that stays on the SQL's own first line (never a substring
  // that could cross the newline before SET/WHERE in these multi-line
  // template literals — see employee_payment_accounts above for why that
  // matters).
  if (lowerSql.includes("asset")) {
    const buildRequisitionRow = (r: any) => {
      const employee = memoryDb.users.find((u: any) => u.id === r.employee_user_id);
      const manager = r.manager_id ? memoryDb.users.find((u: any) => u.id === r.manager_id) : null;
      const asset = r.assigned_asset_id ? memoryDb.assets.find((a: any) => a.id === r.assigned_asset_id) : null;
      return {
        ...r,
        employee_name: employee ? employee.name : null,
        manager_name: manager ? manager.name : null,
        asset_name: asset ? asset.name : null,
        asset_tag: asset ? asset.asset_tag : null
      };
    };

    if (lowerSql.startsWith("select asg.id as assignment_id")) {
      const employeeUserId = Number(params[0]);
      return memoryDb.assetAssignments
        .filter((asg: any) => Number(asg.employee_user_id) === employeeUserId && !asg.returned_date)
        .sort((a: any, b: any) => (a.assigned_date < b.assigned_date ? 1 : -1))
        .map((asg: any) => {
          const asset = memoryDb.assets.find((a: any) => a.id === asg.asset_id);
          return {
            assignment_id: asg.id,
            assigned_date: asg.assigned_date,
            condition_on_assign: asg.condition_on_assign,
            acknowledged_at: asg.acknowledged_at,
            return_requested_at: asg.return_requested_at,
            asset_id: asset ? asset.id : null,
            asset_tag: asset ? asset.asset_tag : null,
            name: asset ? asset.name : null,
            category: asset ? asset.category : null,
            serial_number: asset ? asset.serial_number : null
          };
        });
    }
    if (lowerSql.startsWith("select asg.*, u.name as employee_name")) {
      const assetId = Number(params[0]);
      return memoryDb.assetAssignments
        .filter((asg: any) => Number(asg.asset_id) === assetId)
        .sort((a: any, b: any) => (a.assigned_date < b.assigned_date ? 1 : -1))
        .map((asg: any) => {
          const u = memoryDb.users.find((x: any) => x.id === asg.employee_user_id);
          return { ...asg, employee_name: u ? u.name : null };
        });
    }
    if (lowerSql.startsWith("select * from asset_assignments where id")) {
      const id = Number(params[0]);
      return memoryDb.assetAssignments.filter((asg: any) => asg.id === id);
    }
    if (lowerSql.startsWith("update asset_assignments set acknowledged_at")) {
      const id = Number(params[0]);
      const row = memoryDb.assetAssignments.find((asg: any) => asg.id === id);
      if (row) row.acknowledged_at = new Date();
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("update asset_assignments set return_requested_at")) {
      const id = Number(params[0]);
      const row = memoryDb.assetAssignments.find((asg: any) => asg.id === id);
      if (row) row.return_requested_at = new Date();
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("update asset_assignments set returned_date")) {
      const [condition_on_return, id] = params;
      const row = memoryDb.assetAssignments.find((asg: any) => asg.id === Number(id));
      if (row) {
        row.returned_date = new Date();
        row.condition_on_return = condition_on_return;
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("insert into asset_assignments")) {
      const [asset_id, employee_user_id, requisition_id, condition_on_assign, assigned_by] = params;
      const newId = memoryDb.assetAssignments.length > 0 ? Math.max(...memoryDb.assetAssignments.map((a: any) => a.id)) + 1 : 1;
      memoryDb.assetAssignments.push({
        id: newId,
        asset_id: Number(asset_id),
        employee_user_id: Number(employee_user_id),
        requisition_id: requisition_id === null || requisition_id === undefined ? null : Number(requisition_id),
        assigned_date: new Date(),
        returned_date: null,
        condition_on_assign,
        condition_on_return: null,
        assigned_by: Number(assigned_by),
        acknowledged_at: null,
        return_requested_at: null,
        created_at: new Date()
      });
      return { insertId: newId };
    }
    if (lowerSql.startsWith("update asset_assignments set asset_id")) {
      const [asset_id, id] = params;
      const row = memoryDb.assetAssignments.find((asg: any) => asg.id === Number(id));
      if (row) row.asset_id = Number(asset_id);
      return { affectedRows: row ? 1 : 0 };
    }

    // Flowchart's "গরমিল/ড্যামেজ -> অ্যাডজাস্টমেন্ট/ক্লেইম রিকোয়েস্ট -> ইনভেন্টরি
    // কর্তৃক সমস্যার সমাধান" branch — see AssetManagementRoutes.ts's
    // report-issue/resolve routes.
    if (lowerSql.startsWith("select id from asset_assignment_claims where assignment_id")) {
      const assignmentId = Number(params[0]);
      return memoryDb.assetAssignmentClaims
        .filter((c: any) => Number(c.assignment_id) === assignmentId && c.status === "pending")
        .map((c: any) => ({ id: c.id }));
    }
    if (lowerSql.startsWith("select * from asset_assignment_claims where assignment_id in")) {
      const ids = params.map((p: any) => Number(p));
      return memoryDb.assetAssignmentClaims.filter((c: any) => ids.includes(Number(c.assignment_id)) && c.status === "pending");
    }
    if (lowerSql.startsWith("select * from asset_assignment_claims where id")) {
      const id = Number(params[0]);
      return memoryDb.assetAssignmentClaims.filter((c: any) => c.id === id);
    }
    if (lowerSql.startsWith("select ac.*, u.name as employee_name")) {
      let rows = [...memoryDb.assetAssignmentClaims];
      if (lowerSql.includes("where ac.status")) {
        const status = params[0];
        rows = rows.filter((c: any) => c.status === status);
      }
      rows.sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : -1));
      return rows.map((c: any) => {
        const u = memoryDb.users.find((x: any) => x.id === c.employee_user_id);
        const asg = memoryDb.assetAssignments.find((a: any) => a.id === c.assignment_id);
        const asset = asg ? memoryDb.assets.find((a: any) => a.id === asg.asset_id) : null;
        return {
          ...c,
          employee_name: u ? u.name : null,
          asset_id: asg ? asg.asset_id : null,
          asset_name: asset ? asset.name : null,
          asset_tag: asset ? asset.asset_tag : null
        };
      });
    }
    if (lowerSql.startsWith("insert into asset_assignment_claims")) {
      const [assignment_id, employee_user_id, issue_type, description] = params;
      const newId = memoryDb.assetAssignmentClaims.length > 0 ? Math.max(...memoryDb.assetAssignmentClaims.map((c: any) => c.id)) + 1 : 1;
      memoryDb.assetAssignmentClaims.push({
        id: newId,
        assignment_id: Number(assignment_id),
        employee_user_id: Number(employee_user_id),
        issue_type,
        description,
        status: "pending",
        resolution_note: null,
        resolved_by: null,
        resolved_at: null,
        created_at: new Date()
      });
      return { insertId: newId };
    }
    // "UPDATE asset_assignment_claims\n    SET status = 'resolved', ..." — a
    // newline sits between the table name and SET here too (see the
    // "update assets ... coalesce" note above for why .startsWith() stops at
    // the table name instead of crossing it).
    if (lowerSql.startsWith("update asset_assignment_claims")) {
      const [resolution_note, resolved_by, id] = params;
      const row = memoryDb.assetAssignmentClaims.find((c: any) => c.id === Number(id));
      if (row) {
        row.status = "resolved";
        row.resolution_note = resolution_note;
        row.resolved_by = Number(resolved_by);
        row.resolved_at = new Date();
      }
      return { affectedRows: row ? 1 : 0 };
    }

    if (lowerSql.startsWith("insert into asset_requisitions")) {
      const [employee_user_id, asset_category, reason, urgency, target_date, attachment_filename, attachment_mimetype, attachment_data] = params;
      const newId = memoryDb.assetRequisitions.length > 0 ? Math.max(...memoryDb.assetRequisitions.map((r: any) => r.id)) + 1 : 1;
      memoryDb.assetRequisitions.push({
        id: newId,
        employee_user_id: Number(employee_user_id),
        asset_category,
        reason,
        urgency,
        target_date: target_date || null,
        attachment_filename: attachment_filename || null,
        attachment_mimetype: attachment_mimetype || null,
        attachment_data: attachment_data || null,
        status: "pending",
        manager_id: null,
        manager_decided_at: null,
        manager_remarks: null,
        admin_decided_by: null,
        admin_decided_at: null,
        rejection_reason: null,
        assigned_asset_id: null,
        created_at: new Date(),
        updated_at: new Date()
      });
      return { insertId: newId };
    }
    if (lowerSql.startsWith("insert into asset_requisition_items")) {
      const [requisition_id, item_name, purpose, unit, quantity] = params;
      const newId = memoryDb.assetRequisitionItems.length > 0 ? Math.max(...memoryDb.assetRequisitionItems.map((it: any) => it.id)) + 1 : 1;
      memoryDb.assetRequisitionItems.push({
        id: newId,
        requisition_id: Number(requisition_id),
        item_name,
        purpose,
        unit,
        quantity: Number(quantity),
        created_at: new Date()
      });
      return { insertId: newId };
    }
    if (lowerSql.startsWith("select * from asset_requisition_items where requisition_id in")) {
      const ids = params.map((p: any) => Number(p));
      return memoryDb.assetRequisitionItems
        .filter((it: any) => ids.includes(Number(it.requisition_id)))
        .sort((a: any, b: any) => a.id - b.id);
    }
    if (lowerSql.startsWith("select r.*, u.name as employee_name, m.name as manager_name")) {
      let rows = [...memoryDb.assetRequisitions];
      if (lowerSql.includes("where r.employee_user_id")) {
        const employeeUserId = Number(params[0]);
        rows = rows.filter((r: any) => Number(r.employee_user_id) === employeeUserId);
      } else if (lowerSql.includes("where r.status")) {
        const status = params[0];
        rows = rows.filter((r: any) => r.status === status);
      }
      rows.sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : -1));
      return rows.map(buildRequisitionRow);
    }
    if (lowerSql.startsWith("select * from asset_requisitions where id in")) {
      // fetchByIds("asset_requisitions", ids) — GET /api/my-approvals's
      // narrowed-by-ids lookup, distinct from the single "= ?" case below
      // (both start with "where id", so this has to be checked first).
      const ids = params.map((p: any) => Number(p));
      return memoryDb.assetRequisitions.filter((r: any) => ids.includes(Number(r.id)));
    }
    if (lowerSql.startsWith("select * from asset_requisitions where id")) {
      const id = Number(params[0]);
      return memoryDb.assetRequisitions.filter((r: any) => r.id === id);
    }
    if (lowerSql.startsWith("select * from asset_requisitions")) {
      // Plain, unfiltered fetch — GET /api/approvals (ApprovalRoutes.ts)
      // pulls every requisition once to build its source_label map.
      return [...memoryDb.assetRequisitions];
    }
    if (lowerSql.startsWith("update asset_requisitions set status = 'dispatched'")) {
      const [assigned_asset_id, id] = params;
      const row = memoryDb.assetRequisitions.find((r: any) => r.id === Number(id));
      if (row) {
        row.status = "dispatched";
        row.assigned_asset_id = Number(assigned_asset_id);
        row.updated_at = new Date();
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("update asset_requisitions set status = 'fulfilled'")) {
      const id = Number(params[0]);
      const row = memoryDb.assetRequisitions.find((r: any) => r.id === id && r.status === "dispatched");
      if (row) {
        row.status = "fulfilled";
        row.updated_at = new Date();
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("update asset_requisitions set status = 'approved'")) {
      const [admin_decided_by, id] = params;
      const row = memoryDb.assetRequisitions.find((r: any) => r.id === Number(id));
      if (row) {
        row.status = "approved";
        row.admin_decided_by = Number(admin_decided_by);
        row.admin_decided_at = new Date();
        row.updated_at = new Date();
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("update asset_requisitions set status = 'rejected'")) {
      const [admin_decided_by, rejection_reason, id] = params;
      const row = memoryDb.assetRequisitions.find((r: any) => r.id === Number(id));
      if (row) {
        row.status = "rejected";
        row.admin_decided_by = Number(admin_decided_by);
        row.admin_decided_at = new Date();
        row.rejection_reason = rejection_reason;
        row.updated_at = new Date();
      }
      return { affectedRows: row ? 1 : 0 };
    }

    if (lowerSql.startsWith("select id from assets where asset_tag")) {
      const tag = params[0];
      return memoryDb.assets.filter((a: any) => a.asset_tag === tag).map((a: any) => ({ id: a.id }));
    }
    if (lowerSql.startsWith("select id from assets where id")) {
      const id = Number(params[0]);
      return memoryDb.assets.filter((a: any) => a.id === id).map((a: any) => ({ id: a.id }));
    }
    if (lowerSql.startsWith("select * from assets where id")) {
      const id = Number(params[0]);
      return memoryDb.assets.filter((a: any) => a.id === id);
    }
    if (lowerSql.startsWith("select * from assets")) {
      let rows = [...memoryDb.assets];
      let paramIdx = 0;
      if (lowerSql.includes("status = ?")) {
        const status = params[paramIdx++];
        rows = rows.filter((a: any) => a.status === status);
      }
      if (lowerSql.includes("category = ?")) {
        const category = params[paramIdx++];
        rows = rows.filter((a: any) => a.category === category);
      }
      rows.sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : -1));
      return rows;
    }
    if (lowerSql.startsWith("insert into assets")) {
      const [asset_tag, name, category, serial_number, purchase_date, condition_note, created_by] = params;
      const newId = memoryDb.assets.length > 0 ? Math.max(...memoryDb.assets.map((a: any) => a.id)) + 1 : 1;
      memoryDb.assets.push({
        id: newId,
        asset_tag,
        name,
        category,
        serial_number: serial_number || null,
        purchase_date: purchase_date || null,
        status: "available",
        condition_note: condition_note || null,
        created_by: created_by === null || created_by === undefined ? null : Number(created_by),
        created_at: new Date(),
        updated_at: new Date()
      });
      return { insertId: newId };
    }
    // "UPDATE assets\n    SET name = COALESCE(?, name), ..." — a newline sits
    // between the table name and SET in this one (a multi-line template
    // literal), so this is matched by .includes("coalesce") rather than a
    // .startsWith() that would need to cross that newline (see the design
    // note at the top of this Asset Management block).
    if (lowerSql.startsWith("update assets") && lowerSql.includes("coalesce")) {
      const [name, category, serial_number, purchase_date, status, condition_note, id] = params;
      const row = memoryDb.assets.find((a: any) => a.id === Number(id));
      if (row) {
        if (name !== null && name !== undefined) row.name = name;
        if (category !== null && category !== undefined) row.category = category;
        row.serial_number = serial_number || null;
        row.purchase_date = purchase_date || null;
        if (status !== null && status !== undefined) row.status = status;
        row.condition_note = condition_note || null;
        row.updated_at = new Date();
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("update assets set status = 'assigned'")) {
      const id = Number(params[0]);
      const row = memoryDb.assets.find((a: any) => a.id === id);
      if (row) row.status = "assigned";
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("update assets set status = 'maintenance'")) {
      const id = Number(params[0]);
      const row = memoryDb.assets.find((a: any) => a.id === id);
      if (row) row.status = "maintenance";
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("update asset_requisitions set assigned_asset_id")) {
      const [assigned_asset_id, id] = params;
      const row = memoryDb.assetRequisitions.find((r: any) => r.id === Number(id));
      if (row) {
        row.assigned_asset_id = Number(assigned_asset_id);
        row.updated_at = new Date();
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (lowerSql.startsWith("update assets set status = ? where id")) {
      const [status, id] = params;
      const row = memoryDb.assets.find((a: any) => a.id === Number(id));
      if (row) row.status = status;
      return { affectedRows: row ? 1 : 0 };
    }
  }

  // Exit/Offboarding, Performance Management, Recruitment/ATS, Grievance &
  // Disciplinary, Document Vault — generic simple-table CRUD (see
  // simulateGenericTable's own comment above).
  for (const [table, store] of GENERIC_TABLES) {
    if (lowerSql.includes(table)) {
      const result = simulateGenericTable(table, store, sql, lowerSql, params);
      if (result !== undefined) return result;
    }
  }

  return [];
}
