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

import { companyStore } from "./companyContext";

// Tables with their own company_id column.
const COMPANY_TABLES = new Set(["all_employees", "departments", "branches", "projects"]);

// Tables whose rows belong to an Employee (all_employees.id).
const EMPLOYEE_TABLES = new Set([
  "advance_requests",
  "employee_advances",
  "employee_change_log",
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
  "payrolls",
  "pending_bonuses",
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
  "location_pings"
]);

const ALL_TABLES = [...COMPANY_TABLES, ...EMPLOYEE_TABLES, ...USER_TABLES, "users"];
const TABLE_RE = new RegExp(`\\b(FROM|JOIN)\\s+\`?(${ALL_TABLES.join("|")})\`?(?![\\w\`])(\\s+(?:AS\\s+)?([A-Za-z_][A-Za-z0-9_]*))?`, "gi");

// Words that can follow a table name but are not an alias.
const NOT_ALIAS = new Set(
  "where join left right inner outer cross straight_join natural on using group order limit having union set for lock window as values select into procedure".split(" ")
);

// One specific record → group scope (see header).
const SINGLE_LOOKUP_RE = /\b(?:[A-Za-z_][A-Za-z0-9_]*\.)?(?:id|user_id|employee_id)\s*(?:=\s*\?|IN\s*\(\s*\?)/i;

const int = (n: number) => String(Math.trunc(Number(n)) || 1);

function scopes(companyId: number, groupId: number, group: boolean) {
  const cid = int(companyId);
  const gid = int(groupId);
  const groupCompanies = `SELECT id FROM companies WHERE group_id = ${gid}`;
  const employees = group
    ? `SELECT * FROM all_employees WHERE company_id IN (${groupCompanies})`
    : `SELECT * FROM all_employees WHERE company_id = ${cid} OR id IN (SELECT employee_id FROM employee_company_assignments WHERE company_id = ${cid} AND is_active = 1)`;
  // Accounts that have no Employee record (e.g. an Admin) count in the
  // companies they may enter.
  const users = group
    ? `SELECT id FROM users WHERE group_id = ${gid}`
    : `SELECT user_id FROM (${employees}) se WHERE se.user_id IS NOT NULL
       UNION SELECT a.user_id FROM user_company_access a
         WHERE a.company_id = ${cid} AND a.user_id NOT IN (SELECT user_id FROM all_employees WHERE user_id IS NOT NULL)`;
  return {
    company: (table: string) => (group ? `SELECT * FROM ${table} WHERE company_id IN (${groupCompanies})` : `SELECT * FROM ${table} WHERE company_id = ${cid}`),
    employees,
    employeeRows: (table: string) => `SELECT * FROM ${table} WHERE employee_id IN (SELECT id FROM (${employees}) se2)`,
    userRows: (table: string) => `SELECT * FROM ${table} WHERE user_id IN (${users})`,
    users: `SELECT * FROM users WHERE group_id = ${gid}`
  };
}

// Emergency switch: COMPANY_SCOPE_OFF=1 in the server's environment turns the
// separation off (every company then sees everything, as before step 2).
const SCOPE_OFF = process.env.COMPANY_SCOPE_OFF === "1";

export function scopeSql(sql: string): string {
  const ctx = companyStore.getStore();
  if (!ctx || SCOPE_OFF) return sql;
  const head = sql.trimStart().slice(0, 12).toUpperCase();
  if (head.startsWith("INSERT")) return scopeInsert(sql, ctx.companyId, ctx.groupId);
  if (!head.startsWith("SELECT") && !head.startsWith("(")) return sql;
  const s = scopes(ctx.companyId, ctx.groupId, SINGLE_LOOKUP_RE.test(sql));
  return sql.replace(TABLE_RE, (match, kw: string, table: string, aliasPart: string | undefined, alias: string | undefined) => {
    const t = table.toLowerCase();
    let sub: string;
    if (t === "all_employees") sub = s.employees;
    else if (t === "users") sub = s.users;
    else if (COMPANY_TABLES.has(t)) sub = s.company(t);
    else if (EMPLOYEE_TABLES.has(t)) sub = s.employeeRows(t);
    else sub = s.userRows(t);
    const hasAlias = !!alias && !NOT_ALIAS.has(alias.toLowerCase());
    return `${kw} (${sub}) AS ${hasAlias ? alias : t}${hasAlias ? "" : aliasPart || ""}`;
  });
}

// INSERT INTO <company table> (cols) VALUES (...) → also sets company_id.
// New accounts (users) likewise get the active group.
const INSERT_RE = /^\s*INSERT\s+INTO\s+`?(all_employees|departments|branches|projects|users)`?\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*$/i;
function scopeInsert(sql: string, companyId: number, groupId: number): string {
  const m = sql.match(INSERT_RE);
  if (!m) return sql;
  const col = m[1].toLowerCase() === "users" ? "group_id" : "company_id";
  const val = col === "group_id" ? int(groupId) : int(companyId);
  // Only the plain single-row form; multi-row / ON DUPLICATE / INSERT…SELECT stay as written.
  if (new RegExp(`\\b${col}\\b`, "i").test(m[2]) || /\)\s*,\s*\(|ON\s+DUPLICATE|\bSELECT\b/i.test(m[3])) return sql;
  return `INSERT INTO ${m[1]} (${m[2]}, ${col}) VALUES (${m[3]}, ${val})`;
}
