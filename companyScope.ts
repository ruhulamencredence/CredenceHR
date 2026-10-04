/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Multi-company data separation, applied centrally in queryDB (server.ts) so
// the ~1,400 existing queries don't each need to change.
//
// Inside an authenticated request (companyContext.ts knows the company), every
// SELECT that reads one of the tables below reads it through a filtered
// derived table instead:
//
//   FROM all_employees e   ->   FROM (SELECT * FROM all_employees WHERE <scope>) e
//
// Two scopes:
//   company  lists and reports — only the active company's rows. Employees are
//            those whose own company it is, plus those assigned to it as well
//            (employee_company_assignments). Person-linked data (attendance,
//            leave, payroll…) follows the employee.
//   group    a query that looks up one specific record (… WHERE id = ? /
//            user_id = ? / employee_id = ?) — anything in the account's own
//            group, so someone working in two companies still finds their own
//            leave, profile… from either. Never another group's.
//
// INSERTs into the tables that carry company_id get the active company, so a
// new employee / department / branch / project created while working in a
// sister company belongs to it.
//
// A query written as "/*unscoped*/ SELECT …" is left alone — for the few
// system screens that deliberately span companies (they filter by group
// themselves).
//
// Outside a request (schedulers, startup, login) nothing is rewritten.
// Everything that existed before multi-company is company 1, so company 1 sees
// exactly what it saw before.

import { companyStore, type CompanyContext } from "./companyContext";

// Tables with their own company_id column.
const COMPANY_TABLES = new Set(["all_employees", "departments", "branches", "projects"]);

// Tables whose rows belong to an Employee (all_employees.id).
const EMPLOYEE_TABLES = new Set([
  "advance_requests",
  "employee_advances",
  "employee_change_log",
  "employee_pay_items",
  "employee_payment_accounts",
  "employee_supervisors",
  "employee_transfers",
  "hr_actions",
  "hr_emp_education",
  "hr_emp_experience",
  "hr_emp_family",
  "hr_emp_training",
  "hr_employee_service",
  "hr_info_requests",
  "hr_letter_requests",
  "hr_letters",
  "hr_onboarding_items",
  "late_waivers",
  "payroll_line_items",
  "payrolls",
  "pending_bonuses",
  "salary_adjustments",
  "salary_structures",
  "site_attendance_entries"
]);

// Tables whose rows belong to a login (users.id).
const USER_TABLES = new Set([
  "attendance",
  "attendance_corrections",
  "leave_applications",
  "leave_balances",
  "leave_category_balances",
  "claims",
  "user_claims",
  "conveyance_bills",
  "exit_requests",
  "final_settlements",
  "performance_goals",
  "performance_reviews",
  "disciplinary_actions",
  "employee_documents",
  "location_pings",
  "tracking_notice_recipients"
]);

// Company settings a sister company may use from its mother company instead
// of keeping its own (Admin Panel -> Companies -> the company -> "Uses the
// mother company's…"). A company always sees its own rows; with a kind shared
// it also sees the mother company's rows of those tables, read-only.
export const SHARE_KINDS: { key: string; label: string; tables: string[] }[] = [
  { key: "holidays", label: "Holiday calendar", tables: ["holiday_calendar"] },
  { key: "leave_policy", label: "Leave types & rules", tables: ["leave_categories", "leave_category_policies"] },
  { key: "late_policy", label: "Late attendance policy", tables: ["late_policy_settings"] },
  { key: "payroll_setup", label: "Salary components & pay grades", tables: ["salary_components", "pay_grades"] },
  { key: "hr_templates", label: "Letter templates, onboarding tasks, increment policies & HR settings", tables: ["hr_letter_templates", "hr_onboarding_tasks", "hr_increment_policies", "hr_ops_settings"] },
  {
    key: "approvals",
    label: "Approval templates, HR action approvers & clearance approvers",
    tables: ["approval_templates", "access_templates", "exit_clearance_approvers", "hr_action_approval_steps"]
  },
  { key: "notices", label: "Notices", tables: ["notices"] },
  { key: "assets", label: "Asset inventory", tables: ["assets"] },
  { key: "vehicles", label: "Vehicles", tables: ["vehicles"] },
  { key: "recruitment", label: "Job postings", tables: ["job_postings"] },
  { key: "performance", label: "Performance cycles", tables: ["performance_cycles"] },
  { key: "bill_claim_policy", label: "Bill claim policy & categories", tables: ["bill_claim_categories", "bill_claim_policy_settings"] }
];
export const CONFIG_TABLES = new Map<string, string>(SHARE_KINDS.flatMap((k) => k.tables.map((t) => [t, k.key] as [string, string])));

// Company-owned records that are never shared.
export const OWN_TABLES = new Set([
  "site_attendance_teams",
  "site_attendance_settings",
  "zk_devices",
  "hr_saved_reports",
  "asset_requisitions",
  "vehicle_requisitions",
  "grievances",
  "tasks",
  "task_recurrences",
  "mobile_sims",
  "mobile_bills",
  "mobile_limit_policies",
  "mobile_limit_requests"
]);

// Shared by every company of a group (PEPM budgets & rate file, chat…) but
// never seen by another group. Own group_id column.
export const GROUP_TABLES = new Set([
  "budgets",
  "mpr_numbers",
  "rate_list",
  "material_categories",
  "delivery_date_conditions",
  "chat_rooms",
  "server_profiles",
  // Records someone raises in a group's workspace — kept with that group even
  // when the system owner raised them while working inside it.
  "approval_requests",
  "leave_balance_workflows",
  "case_feedback"
]);

// The link each of those had before it got its own group_id (CompanyRoutes.ts
// fills group_id from it once).
export const GROUP_BACKFILL: [string, string][] = [
  ["approval_requests", "requested_by"],
  ["leave_balance_workflows", "created_by"],
  ["case_feedback", "user_id"]
];

// Rows that hang off another record (a budget's items, a chat room's
// messages, an account's alerts…): they are seen in the group their parent
// belongs to. [link column, parent table]. Rows whose link is empty date from
// before multi-company, so they stay with the original group (1).
export const LINKED_TABLES = new Map<string, [string, string]>([
  ["admin_module_permissions", ["user_id", "users"]],
  ["admin_module_permission_layers", ["user_id", "users"]],
  ["alerts", ["user_id", "users"]],
  ["approval_chain_steps", ["user_id", "users"]],
  ["approval_template_steps", ["template_id", "approval_templates"]],
  ["approval_template_step_approvers", ["step_id", "approval_template_steps"]],
  ["asset_assignments", ["asset_id", "assets"]],
  ["asset_assignment_claims", ["assignment_id", "asset_assignments"]],
  ["asset_requisition_items", ["requisition_id", "asset_requisitions"]],
  ["asset_requisition_events", ["requisition_id", "asset_requisitions"]],
  ["attendance_report_department_access", ["user_id", "users"]],
  ["budget_items", ["budget_id", "budgets"]],
  ["budget_submissions", ["budget_id", "budgets"]],
  ["job_submissions", ["job_id", "jobs"]],
  ["entries", ["budget_id", "budgets"]],
  ["jobs", ["budget_id", "budgets"]],
  ["job_edit_requests", ["requested_by", "users"]],
  ["entry_edit_history", ["entry_id", "entries"]],
  ["entry_permanent_delete_log", ["permanently_deleted_by", "users"]],
  ["job_candidates", ["posting_id", "job_postings"]],
  ["candidate_interviews", ["candidate_id", "job_candidates"]],
  ["chat_messages", ["room_id", "chat_rooms"]],
  ["chat_room_members", ["room_id", "chat_rooms"]],
  ["chat_room_reads", ["room_id", "chat_rooms"]],
  ["chat_push_tokens", ["user_id", "users"]],
  ["conveyance_bill_items", ["bill_id", "conveyance_bills"]],
  ["conveyance_claim_department_access", ["user_id", "users"]],
  ["document_signatures", ["document_id", "employee_documents"]],
  ["employee_template_assignments", ["employee_user_id", "users"]],
  ["exit_clearance_items", ["exit_id", "exit_requests"]],
  ["hr_report_runs", ["report_id", "hr_saved_reports"]],
  ["leave_application_department_access", ["user_id", "users"]],
  ["leave_balance_workflow_items", ["workflow_id", "leave_balance_workflows"]],
  ["notice_dismissals", ["notice_id", "notices"]],
  ["notice_targets", ["notice_id", "notices"]],
  ["pay_grade_components", ["pay_grade_id", "pay_grades"]],
  ["payroll_payment_splits", ["payroll_id", "payrolls"]],
  ["site_attendance_members", ["team_id", "site_attendance_teams"]],
  ["task_assignees", ["task_id", "tasks"]],
  ["task_comments", ["task_id", "tasks"]],
  ["mobile_sim_events", ["sim_id", "mobile_sims"]],
  ["site_attendance_sheets", ["team_id", "site_attendance_teams"]],
  ["user_access_audit", ["target_user_id", "users"]],
  ["user_claim_references", ["user_claim_id", "user_claims"]],
  ["user_claim_items", ["user_claim_id", "user_claims"]],
  ["user_profile_details", ["user_id", "users"]],
  ["user_project_permissions", ["user_id", "users"]],
  ["zk_attendance_logs", ["device_id", "zk_devices"]]
]);

const ALL_TABLES = [
  ...COMPANY_TABLES,
  ...EMPLOYEE_TABLES,
  ...USER_TABLES,
  ...CONFIG_TABLES.keys(),
  ...OWN_TABLES,
  ...GROUP_TABLES,
  ...LINKED_TABLES.keys(),
  "users"
];
const TABLE_RE = new RegExp(`\\b(FROM|JOIN)\\s+\`?(${ALL_TABLES.join("|")})\`?(?![\\w\`])(\\s+(?:AS\\s+)?([A-Za-z_][A-Za-z0-9_]*))?`, "gi");

// Words that can follow a table name but are not an alias.
const NOT_ALIAS = new Set(
  "where join left right inner outer cross straight_join natural on using group order limit having union set for lock window as values select into procedure".split(" ")
);

// One specific record → group scope (see header).
const SINGLE_LOOKUP_RE = /\b(?:[A-Za-z_][A-Za-z0-9_]*\.)?(?:id|user_id|employee_id)\s*(?:=\s*\?|IN\s*\(\s*\?)/i;

const int = (n: number) => String(Math.trunc(Number(n)) || 1);

function scopes(ctx: CompanyContext, group: boolean) {
  const cid = int(ctx.companyId);
  const gid = int(ctx.groupId);
  const groupCompanies = `SELECT id FROM companies WHERE group_id = ${gid}`;
  const employees = group
    ? `SELECT * FROM all_employees WHERE company_id IN (${groupCompanies})`
    : `SELECT * FROM all_employees WHERE company_id = ${cid} OR id IN (SELECT employee_id FROM employee_company_assignments WHERE company_id = ${cid} AND is_active = 1)`;
  // Accounts that have no Employee record (e.g. an Admin) count in the
  // companies they may enter.
  const self = ctx.userId ? ` OR id = ${int(ctx.userId)}` : "";
  const users = group
    ? `SELECT id FROM users WHERE group_id = ${gid}${self}`
    : `SELECT user_id FROM (${employees}) se WHERE se.user_id IS NOT NULL
       UNION SELECT a.user_id FROM user_company_access a
         WHERE a.company_id = ${cid} AND a.user_id NOT IN (SELECT user_id FROM all_employees WHERE user_id IS NOT NULL)`;
  const shared = new Set(ctx.shared || []);
  const mother = ctx.motherId && ctx.motherId !== ctx.companyId ? int(ctx.motherId) : null;
  return {
    company: (table: string) => (group ? `SELECT * FROM ${table} WHERE company_id IN (${groupCompanies})` : `SELECT * FROM ${table} WHERE company_id = ${cid}`),
    config: (table: string) =>
      mother && shared.has(CONFIG_TABLES.get(table) || "")
        ? `SELECT * FROM ${table} WHERE company_id IN (${cid}, ${mother})`
        : `SELECT * FROM ${table} WHERE company_id = ${cid}`,
    own: (table: string) => `SELECT * FROM ${table} WHERE company_id = ${cid}`,
    employees,
    employeeRows: (table: string) => `SELECT * FROM ${table} WHERE employee_id IN (SELECT id FROM (${employees}) se2)`,
    userRows: (table: string) => `SELECT * FROM ${table} WHERE user_id IN (${users})`,
    // Lists of accounts: the company's employees' logins, anyone given access
    // to it (e.g. group HR) and the Superadmin; accounts that never signed in
    // since multi-company count in the mother company. One specific account
    // (… WHERE id = ?) is found anywhere in the group.
    users: group
      ? `SELECT * FROM users WHERE group_id = ${gid}${self}`
      : `SELECT * FROM users WHERE group_id = ${gid} AND (role = 'superadmin'
           OR id IN (SELECT user_id FROM (${employees}) su WHERE su.user_id IS NOT NULL)
           OR id IN (SELECT user_id FROM user_company_access WHERE company_id = ${cid})
           ${mother ? "" : "OR id NOT IN (SELECT user_id FROM user_company_access)"})`
  };
}

// Every row of <table> that belongs to the group (any of its companies).
function groupRows(table: string, gid: string): string {
  const companies = `SELECT id FROM companies WHERE group_id = ${gid}`;
  if (table === "users") return `SELECT * FROM users WHERE group_id = ${gid}`;
  if (GROUP_TABLES.has(table)) return `SELECT * FROM ${table} WHERE group_id = ${gid}`;
  if (COMPANY_TABLES.has(table) || CONFIG_TABLES.has(table) || OWN_TABLES.has(table)) return `SELECT * FROM ${table} WHERE company_id IN (${companies})`;
  if (EMPLOYEE_TABLES.has(table)) return `SELECT * FROM ${table} WHERE employee_id IN (SELECT id FROM all_employees WHERE company_id IN (${companies}))`;
  if (USER_TABLES.has(table)) return `SELECT * FROM ${table} WHERE user_id IN (SELECT id FROM users WHERE group_id = ${gid})`;
  const [col, parent] = LINKED_TABLES.get(table)!;
  return `SELECT * FROM ${table} WHERE ${linkCond(col, parent, gid)}`;
}
function linkCond(col: string, parent: string, gid: string): string {
  const ids = parent === "users" ? `SELECT id FROM users WHERE group_id = ${gid}` : `SELECT id FROM (${groupRows(parent, gid)}) gp`;
  return gid === "1" ? `(${col} IN (${ids}) OR ${col} IS NULL)` : `${col} IN (${ids})`;
}

// Emergency switch: COMPANY_SCOPE_OFF=1 in the server's environment turns the
// separation off (every company then sees everything, as before step 2).
const SCOPE_OFF = process.env.COMPANY_SCOPE_OFF === "1";

export function scopeSql(sql: string): string {
  const ctx = companyStore.getStore();
  if (!ctx || SCOPE_OFF) return sql;
  const head = sql.trimStart().slice(0, 12).toUpperCase();
  if (head.startsWith("INSERT")) return scopeInsert(sql, ctx.companyId, ctx.groupId);
  if (head.startsWith("UPDATE") || head.startsWith("DELETE")) return guardWrite(sql, ctx);
  if (!head.startsWith("SELECT") && !head.startsWith("(")) return sql;
  const s = scopes(ctx, !!ctx.wholeGroup || SINGLE_LOOKUP_RE.test(sql));
  const gid = int(ctx.groupId);
  return sql.replace(TABLE_RE, (match, kw: string, table: string, aliasPart: string | undefined, alias: string | undefined) => {
    const t = table.toLowerCase();
    let sub: string;
    if (t === "all_employees") sub = s.employees;
    else if (t === "users") sub = s.users;
    else if (COMPANY_TABLES.has(t)) sub = s.company(t);
    else if (CONFIG_TABLES.has(t)) sub = s.config(t);
    else if (OWN_TABLES.has(t)) sub = s.own(t);
    else if (EMPLOYEE_TABLES.has(t)) sub = s.employeeRows(t);
    else if (GROUP_TABLES.has(t) || LINKED_TABLES.has(t)) sub = groupRows(t, gid);
    else sub = s.userRows(t);
    const hasAlias = !!alias && !NOT_ALIAS.has(alias.toLowerCase());
    return `${kw} (${sub}) AS ${hasAlias ? alias : t}${hasAlias ? "" : aliasPart || ""}`;
  });
}

// UPDATE / DELETE on a company's own tables only ever touch that company's
// rows (settings shared from the mother company are read-only here); employees,
// departments, branches and projects stay within the company's group, and so
// does everything else a group owns.
const WRITE_RE = /^\s*(UPDATE\s+`?([A-Za-z_][A-Za-z0-9_]*)`?\s+SET\b[\s\S]*?|DELETE\s+FROM\s+`?([A-Za-z_][A-Za-z0-9_]*)`?\s+)\bWHERE\b([\s\S]*)$/i;
// The same without a WHERE ("DELETE FROM material_categories").
const WRITE_ALL_RE = /^\s*(UPDATE\s+`?([A-Za-z_][A-Za-z0-9_]*)`?\s+SET\b[\s\S]*|DELETE\s+FROM\s+`?([A-Za-z_][A-Za-z0-9_]*)`?)\s*$/i;
function writeGuard(table: string, ctx: CompanyContext): string | null {
  const gid = int(ctx.groupId);
  if (CONFIG_TABLES.has(table) || OWN_TABLES.has(table)) return `company_id = ${int(ctx.companyId)}`;
  if (COMPANY_TABLES.has(table)) return `company_id IN (SELECT id FROM companies WHERE group_id = ${gid})`;
  if (GROUP_TABLES.has(table)) return `group_id = ${gid}`;
  const link = LINKED_TABLES.get(table);
  if (link) return linkCond(link[0], link[1], gid);
  if (EMPLOYEE_TABLES.has(table)) return linkCond("employee_id", "all_employees", gid);
  if (USER_TABLES.has(table)) return linkCond("user_id", "users", gid);
  return null;
}
function guardWrite(sql: string, ctx: CompanyContext): string {
  const m = sql.match(WRITE_RE);
  if (!m) {
    const all = sql.match(WRITE_ALL_RE);
    if (!all || /\b(ORDER\s+BY|LIMIT|JOIN|SELECT|WHERE)\b/i.test(all[1])) return sql;
    const extra = writeGuard(String(all[2] || all[3]).toLowerCase(), ctx);
    return extra ? `${all[1]} WHERE ${extra}` : sql;
  }
  const table = String(m[2] || m[3]).toLowerCase();
  const cond = m[4];
  // Leave anything unusual (joins, ORDER/LIMIT, subqueries) exactly as written.
  if (/\b(ORDER\s+BY|LIMIT|JOIN|SELECT)\b/i.test(cond)) return sql;
  const extra = writeGuard(table, ctx);
  if (!extra) return sql;
  return `${m[1]}WHERE (${cond}) AND ${extra}`;
}

// INSERT INTO <company table> (cols) VALUES (...) → also sets company_id.
// New accounts (users) and a group's own records likewise get the group.
const INSERT_TABLES = [...COMPANY_TABLES, ...CONFIG_TABLES.keys(), ...OWN_TABLES, ...GROUP_TABLES, "users"];
const INSERT_RE = new RegExp(`^\\s*INSERT\\s+INTO\\s+\`?(${INSERT_TABLES.join("|")})\`?\\s*\\(([^)]*)\\)\\s*VALUES\\s*\\(`, "i");
function scopeInsert(sql: string, companyId: number, groupId: number): string {
  const m = sql.match(INSERT_RE);
  if (!m) return sql;
  const table = m[1].toLowerCase();
  const byGroup = table === "users" || GROUP_TABLES.has(table);
  const col = byGroup ? "group_id" : "company_id";
  const val = byGroup ? int(groupId) : int(companyId);
  if (new RegExp(`\\b${col}\\b`, "i").test(m[2])) return sql;
  // The single row of values, up to its matching ")".
  const start = m[0].length;
  let depth = 1;
  let i = start;
  let quote = "";
  for (; i < sql.length && depth > 0; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote && sql[i - 1] !== "\\") quote = "";
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  if (depth !== 0) return sql;
  const values = sql.slice(start, i - 1);
  const rest = sql.slice(i);
  // Only the plain single-row form, optionally with ON DUPLICATE KEY UPDATE;
  // multi-row / INSERT…SELECT stay as written.
  if (/\bSELECT\b/i.test(values) || !/^\s*(ON\s+DUPLICATE\s+KEY\s+UPDATE\b[\s\S]*)?$/i.test(rest)) return sql;
  return `INSERT INTO ${m[1]} (${m[2]}, ${col}) VALUES (${values}, ${val})${rest}`;
}

// Columns to add to a multi-row bulk insert (server.ts bulkInsert) so the rows
// belong to the active group/company.
export function scopeColumnsFor(table: string): { col: string; val: number } | null {
  const ctx = companyStore.getStore();
  if (!ctx || SCOPE_OFF) return null;
  const t = table.toLowerCase();
  if (GROUP_TABLES.has(t)) return { col: "group_id", val: Number(int(ctx.groupId)) };
  if (COMPANY_TABLES.has(t) || CONFIG_TABLES.has(t) || OWN_TABLES.has(t)) return { col: "company_id", val: Number(int(ctx.companyId)) };
  return null;
}
