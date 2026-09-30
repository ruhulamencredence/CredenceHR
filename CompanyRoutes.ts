/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Multi-company — groups, companies and who may work in which company.
//
//   company_groups        A group of companies (e.g. Credence Group). One
//                         look and feel per group; companies of different
//                         groups never see each other.
//   companies             The companies of a group — one is the mother
//                         company. short_code prefixes that company's
//                         Employee IDs and letter reference numbers.
//   user_company_access   Which companies an account may switch into (the
//                         Superadmin may enter every company of their group).
//                         Module Access (admin_module_permissions) is kept per
//                         company, so the same person can be HR in one company
//                         and have read-only reports in another.
//   employee_company_assignments
//                         Additional companies an Employee also works for,
//                         besides their own (all_employees.company_id).
//
// Safe migration: every table gets company_id with DEFAULT 1, and company 1 is
// the mother company seeded below — so everything that existed before this
// (employees, permissions…) simply belongs to it. Nothing is deleted or moved.
//
// The active company per request comes from resolveCompanyContext(), called by
// authenticateToken in server.ts (see companyContext.ts).

import type { Express } from "express";
import bcrypt from "bcryptjs";
import { DEFAULT_COMPANY_ID, DEFAULT_GROUP_ID, activeCompanyId, type CompanyContext } from "./companyContext";
import { SHARE_KINDS, CONFIG_TABLES, OWN_TABLES, GROUP_TABLES } from "./companyScope";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface CompanyRouteDeps {
  authenticateToken: any;
  requireSuperAdmin: any;
  queryDB: QueryDB;
  getAdminModules: (userId: number) => Promise<string[]>;
}

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const CODE_RE = /^[A-Z][A-Z0-9]{1,7}$/;

export async function ensureCompanySchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  const run = async (label: string, sql: string, ignore: string[] = []) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (!ignore.includes(err.code)) console.warn(`⚠️ Multi-company (${label}): ${err.message}`);
    }
  };
  await run(
    "company_groups",
    `CREATE TABLE IF NOT EXISTS company_groups (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      short_name VARCHAR(50) NULL,
      logo_mime VARCHAR(100) NULL,
      logo_data LONGBLOB NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await run(
    "companies",
    `CREATE TABLE IF NOT EXISTS companies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      group_id INT NOT NULL,
      name VARCHAR(200) NOT NULL,
      short_code VARCHAR(10) NOT NULL,
      is_mother TINYINT(1) NOT NULL DEFAULT 0,
      address VARCHAR(500) NULL,
      phone VARCHAR(60) NULL,
      email VARCHAR(150) NULL,
      website VARCHAR(150) NULL,
      logo_mime VARCHAR(100) NULL,
      logo_data LONGBLOB NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_company_code (group_id, short_code),
      FOREIGN KEY (group_id) REFERENCES company_groups(id)
    )`
  );
  await run(
    "user_company_access",
    `CREATE TABLE IF NOT EXISTS user_company_access (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      company_id INT NOT NULL,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_company (user_id, company_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    )`
  );
  await run(
    "employee_company_assignments",
    `CREATE TABLE IF NOT EXISTS employee_company_assignments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      company_id INT NOT NULL,
      employee_code VARCHAR(50) NULL,
      designation VARCHAR(150) NULL,
      department VARCHAR(150) NULL,
      start_date DATE NULL,
      end_date DATE NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      note VARCHAR(500) NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_employee_company (employee_id, company_id),
      FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    )`
  );

  // Seed the existing organisation as group 1 / mother company 1 (first run only).
  try {
    const [groups]: any = await dbPool.query("SELECT id FROM company_groups LIMIT 1");
    if (!groups.length) await dbPool.query("INSERT INTO company_groups (id, name, short_name) VALUES (1, 'Credence Group', 'Credence')");
    const [companies]: any = await dbPool.query("SELECT id FROM companies LIMIT 1");
    if (!companies.length) {
      // Existing Employee IDs look like CHL-0001 — keep that prefix.
      const [codes]: any = await dbPool.query("SELECT employee_id FROM all_employees WHERE employee_id LIKE '%-%' LIMIT 50").catch(() => [[]]);
      const counts = new Map<string, number>();
      for (const r of codes) {
        const p = String(r.employee_id).split("-")[0].toUpperCase();
        if (CODE_RE.test(p)) counts.set(p, (counts.get(p) || 0) + 1);
      }
      const code = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "CHL";
      await dbPool.query("INSERT INTO companies (id, group_id, name, short_code, is_mother) VALUES (1, 1, 'Credence Housing Limited', ?, 1)", [code]);
    }
  } catch (err: any) {
    console.warn("⚠️ Multi-company seed: " + err.message);
  }

  // Existing rows belong to company 1 via the column default.
  await run("users.group_id", "ALTER TABLE users ADD COLUMN group_id INT NOT NULL DEFAULT 1", ["ER_DUP_FIELDNAME"]);

  // Workspaces: each group signs in through its own workspace code (typed on
  // the page before the login form), with its own logo / name there.
  await run("company_groups.workspace_code", "ALTER TABLE company_groups ADD COLUMN workspace_code VARCHAR(40) NULL", ["ER_DUP_FIELDNAME"]);
  await run("company_groups workspace key", "ALTER TABLE company_groups ADD UNIQUE KEY unique_workspace_code (workspace_code)", ["ER_DUP_KEYNAME"]);
  await run("company_groups.tagline", "ALTER TABLE company_groups ADD COLUMN tagline VARCHAR(200) NULL", ["ER_DUP_FIELDNAME"]);
  await run("company_groups.is_active", "ALTER TABLE company_groups ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1", ["ER_DUP_FIELDNAME"]);
  await run("group 1 workspace", "UPDATE company_groups SET workspace_code = 'credence' WHERE id = 1 AND workspace_code IS NULL");
  // The platform owner(s) — who may create new workspaces. On the first run
  // that's the existing Superadmin(s) of the original group.
  try {
    await dbPool.query("ALTER TABLE users ADD COLUMN is_platform_admin TINYINT(1) NOT NULL DEFAULT 0");
    await dbPool.query("UPDATE users SET is_platform_admin = 1 WHERE role = 'superadmin' AND group_id = 1");
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") console.warn("⚠️ Multi-company (users.is_platform_admin): " + err.message);
  }
  await run("all_employees.company_id", "ALTER TABLE all_employees ADD COLUMN company_id INT NOT NULL DEFAULT 1", ["ER_DUP_FIELDNAME"]);
  await run("all_employees index", "ALTER TABLE all_employees ADD INDEX idx_employee_company (company_id)", ["ER_DUP_KEYNAME"]);

  // Departments, branches and projects belong to a company too; their names
  // only need to be unique within it (a sister company can also have "Accounts").
  for (const [table, oldKey, col] of [
    ["departments", "name", "name"],
    ["branches", "branch_name", "branch_name"],
    ["projects", "project_name", "project_name"]
  ]) {
    await run(`${table}.company_id`, `ALTER TABLE ${table} ADD COLUMN company_id INT NOT NULL DEFAULT 1`, ["ER_DUP_FIELDNAME"]);
    await run(`${table} key`, `ALTER TABLE ${table} ADD UNIQUE KEY unique_company_${col} (company_id, ${col})`, ["ER_DUP_KEYNAME"]);
    await run(`${table} old key`, `ALTER TABLE ${table} DROP INDEX ${oldKey}`, ["ER_CANT_DROP_FIELD_OR_KEY"]);
  }

  // Company settings and company-owned records (companyScope.ts): every row so
  // far is the mother company's (company 1) via the column default.
  for (const table of [...CONFIG_TABLES.keys(), ...OWN_TABLES]) {
    await run(`${table}.company_id`, `ALTER TABLE ${table} ADD COLUMN company_id INT NOT NULL DEFAULT 1`, ["ER_DUP_FIELDNAME", "ER_NO_SUCH_TABLE"]);
    await run(`${table} company index`, `ALTER TABLE ${table} ADD INDEX idx_${table}_company (company_id)`, ["ER_DUP_KEYNAME", "ER_NO_SUCH_TABLE"]);
  }
  // Names / keys that only need to be unique within a company.
  for (const [table, oldKey, cols] of [
    ["holiday_calendar", "unique_holiday_entry_date_group", "entry_date, applies_to"],
    ["leave_categories", "unique_leave_category_key", "category_key"],
    ["leave_category_policies", "uniq_leave_category_policy", "category_key"],
    ["salary_components", "unique_component_name", "name"],
    ["pay_grades", "unique_grade_name", "grade_name"],
    ["hr_ops_settings", "setting_key", "setting_key"],
    ["exit_clearance_approvers", "department", "department"],
    ["assets", "asset_tag", "asset_tag"]
  ]) {
    await run(`${table} company key`, `ALTER TABLE ${table} ADD UNIQUE KEY ucompany_${oldKey} (company_id, ${cols})`, ["ER_DUP_KEYNAME", "ER_NO_SUCH_TABLE"]);
    await run(`${table} old key`, `ALTER TABLE ${table} DROP INDEX ${oldKey}`, ["ER_CANT_DROP_FIELD_OR_KEY", "ER_NO_SUCH_TABLE"]);
  }
  // A group's own records (PEPM budgets and rate file, chat rooms…): shared by
  // its companies, never seen by another group. Everything so far is group 1's.
  for (const table of GROUP_TABLES) {
    await run(`${table}.group_id`, `ALTER TABLE ${table} ADD COLUMN group_id INT NOT NULL DEFAULT 1`, ["ER_DUP_FIELDNAME", "ER_NO_SUCH_TABLE"]);
    await run(`${table} group index`, `ALTER TABLE ${table} ADD INDEX idx_${table}_group (group_id)`, ["ER_DUP_KEYNAME", "ER_NO_SUCH_TABLE"]);
  }
  await run(
    "delivery_date_conditions group key",
    "ALTER TABLE delivery_date_conditions ADD UNIQUE KEY ugroup_delivery_condition (group_id, condition_type, scope, scope_id)",
    ["ER_DUP_KEYNAME", "ER_NO_SUCH_TABLE"]
  );
  await run("delivery_date_conditions old key", "ALTER TABLE delivery_date_conditions DROP INDEX uniq_delivery_condition", [
    "ER_CANT_DROP_FIELD_OR_KEY",
    "ER_NO_SUCH_TABLE"
  ]);
  await run("delivery_date_conditions group defaults", SEED_GROUP_DEFAULTS, ["ER_NO_SUCH_TABLE"]);
  await run("companies.shared_settings", "ALTER TABLE companies ADD COLUMN shared_settings TEXT NULL", ["ER_DUP_FIELDNAME"]);

  // Module Access per company: add the column, widen the unique key to
  // include it (new key first, so the user_id foreign key always has an index),
  // then drop the old one.
  await run("admin_module_permissions.company_id", "ALTER TABLE admin_module_permissions ADD COLUMN company_id INT NOT NULL DEFAULT 1", ["ER_DUP_FIELDNAME"]);
  await run(
    "admin_module_permissions key",
    "ALTER TABLE admin_module_permissions ADD UNIQUE KEY unique_user_company_module (user_id, company_id, module_key)",
    ["ER_DUP_KEYNAME"]
  );
  await run("admin_module_permissions old key", "ALTER TABLE admin_module_permissions DROP INDEX unique_user_module", ["ER_CANT_DROP_FIELD_OR_KEY"]);
  await run(
    "admin_module_permission_layers.company_id",
    "ALTER TABLE admin_module_permission_layers ADD COLUMN company_id INT NOT NULL DEFAULT 1",
    ["ER_DUP_FIELDNAME"]
  );
  await run(
    "admin_module_permission_layers key",
    "ALTER TABLE admin_module_permission_layers ADD UNIQUE KEY unique_user_company_module_layer (user_id, company_id, module_key, layer_key)",
    ["ER_DUP_KEYNAME"]
  );
  await run(
    "admin_module_permission_layers old key",
    "ALTER TABLE admin_module_permission_layers DROP INDEX unique_user_module_layer",
    ["ER_CANT_DROP_FIELD_OR_KEY"]
  );
}

// Every group starts with the two Global delivery-date rows the PEPM Condition
// Set screen expects (disabled, as for the original group).
const SEED_GROUP_DEFAULTS = `INSERT IGNORE INTO delivery_date_conditions (group_id, condition_type, scope, scope_id, min_lead_days, apply_to_admins, enabled)
  SELECT g.id, t.ct, 'global', 0, 0, 0, 0 FROM company_groups g CROSS JOIN (SELECT 'entry' AS ct UNION SELECT 'job_edit') t`;

// ---------------------------------------------------------------------------
// Resolving the active company for a request
// ---------------------------------------------------------------------------

interface AccessInfo {
  at: number;
  groupId: number;
  allowed: number[];
  defaultId: number;
  motherId: number;
  shared: Map<number, string[]>;
}

// Which kinds of settings a company uses from its mother company. Stored as a
// JSON list in companies.shared_settings; empty (never set) means all of them,
// so a new sister company starts with the mother company's rules.
export function sharedKindsOf(c: any, isMother: boolean): string[] {
  if (isMother) return [];
  if (c?.shared_settings == null || c.shared_settings === "") return SHARE_KINDS.map((k) => k.key);
  try {
    const v = JSON.parse(String(c.shared_settings));
    return Array.isArray(v) ? v.filter((k) => SHARE_KINDS.some((x) => x.key === k)) : [];
  } catch {
    return [];
  }
}

// Context for background jobs acting for one company (e.g. a scheduled report).
export async function contextForCompany(queryDB: QueryDB, companyId: number): Promise<CompanyContext> {
  const all: any[] = (await queryDB("SELECT * FROM companies").catch(() => [])) || [];
  const c = all.find((x) => Number(x.id) === Number(companyId)) || all.find((x) => Number(x.id) === DEFAULT_COMPANY_ID);
  const groupId = Number(c?.group_id ?? DEFAULT_GROUP_ID);
  const mother = all.find((x) => Number(x.group_id) === groupId && Number(x.is_mother) === 1) || c;
  return {
    companyId: Number(c?.id ?? DEFAULT_COMPANY_ID),
    groupId,
    motherId: Number(mother?.id ?? DEFAULT_COMPANY_ID),
    shared: sharedKindsOf(c, Number(c?.id) === Number(mother?.id))
  };
}
const accessCache = new Map<number, AccessInfo>();
const ACCESS_TTL_MS = 30 * 1000;
export function invalidateCompanyAccess(userId?: number) {
  if (userId === undefined) accessCache.clear();
  else accessCache.delete(userId);
}

async function companiesOfGroup(queryDB: QueryDB, groupId: number): Promise<any[]> {
  const rows: any[] = (await queryDB("SELECT * FROM companies").catch(() => [])) || [];
  return rows.filter((c) => Number(c.group_id) === groupId);
}

export async function loadCompanyAccess(queryDB: QueryDB, user: { id: number; role?: string }): Promise<AccessInfo> {
  const cached = accessCache.get(Number(user.id));
  if (cached && Date.now() - cached.at < ACCESS_TTL_MS) return cached;
  const userRows: any[] = (await queryDB("SELECT * FROM users WHERE id = ?", [user.id]).catch(() => [])) || [];
  const u = userRows.find((r) => Number(r.id) === Number(user.id));
  const groupId = Number(u?.group_id ?? DEFAULT_GROUP_ID) || DEFAULT_GROUP_ID;
  const role = u?.role || user.role;
  const companies = (await companiesOfGroup(queryDB, groupId)).filter((c) => Number(c.is_active ?? 1) === 1);
  const activeIds = new Set(companies.map((c) => Number(c.id)));
  const mother = companies.find((c) => Number(c.is_mother) === 1) || companies[0];
  const rows: any[] = ((await queryDB("SELECT * FROM user_company_access WHERE user_id = ?", [user.id]).catch(() => [])) || []).filter(
    (r: any) => Number(r.user_id) === Number(user.id)
  );
  let allowed = rows.map((r) => Number(r.company_id)).filter((id) => activeIds.has(id));
  let defaultId = Number(rows.find((r) => Number(r.is_default) === 1 && activeIds.has(Number(r.company_id)))?.company_id || 0);
  if (!rows.length && mother) {
    // First visit (an existing account, or one just created): it works in
    // the company of the Employee it belongs to, else the group's mother
    // company — exactly as before multi-company.
    const empRows: any[] = (await queryDB("SELECT * FROM all_employees WHERE user_id = ?", [user.id]).catch(() => [])) || [];
    const own = Number(empRows.find((e) => Number(e.user_id) === Number(user.id))?.company_id || 0);
    const home = own && activeIds.has(own) ? own : Number(mother.id);
    await queryDB("INSERT INTO user_company_access (user_id, company_id, is_default) VALUES (?, ?, ?)", [user.id, home, 1]).catch(() => {});
    allowed = [home];
    defaultId = home;
  }
  if (role === "superadmin") allowed = companies.map((c) => Number(c.id));
  if (!allowed.length) allowed = [mother ? Number(mother.id) : DEFAULT_COMPANY_ID];
  if (!defaultId || !allowed.includes(defaultId)) defaultId = allowed.includes(Number(mother?.id)) ? Number(mother.id) : allowed[0];
  const shared = new Map<number, string[]>(companies.map((c) => [Number(c.id), sharedKindsOf(c, Number(c.id) === Number(mother?.id))]));
  const info = { at: Date.now(), groupId, allowed, defaultId, motherId: Number(mother?.id ?? DEFAULT_COMPANY_ID), shared };
  accessCache.set(Number(user.id), info);
  return info;
}

// The company this request works in: the one asked for (X-Company-Id), if the
// account may enter it, else their default company.
export async function resolveCompanyContext(queryDB: QueryDB, user: { id: number; role?: string }, requested: any): Promise<CompanyContext> {
  const info = await loadCompanyAccess(queryDB, user);
  const want = Number(Array.isArray(requested) ? requested[0] : requested);
  const companyId = want && info.allowed.includes(want) ? want : info.defaultId;
  return { companyId, groupId: info.groupId, motherId: info.motherId, shared: info.shared.get(companyId) || [] };
}

// Next Employee ID for a company: its short code + the next number after the
// highest already used with that prefix anywhere (CPL-0007 -> CPL-0008).
export async function nextEmployeeCode(queryDB: QueryDB, companyId: number): Promise<{ code: string; prefix: string }> {
  const rows: any[] = (await queryDB("SELECT * FROM companies WHERE id = ?", [companyId])) || [];
  const c = rows.find((r) => Number(r.id) === Number(companyId));
  if (!c) throw Object.assign(new Error("Company not found."), { statusCode: 404 });
  const prefix = String(c.short_code).toUpperCase();
  const employees: any[] = (await queryDB("/*unscoped*/ SELECT employee_id FROM all_employees").catch(() => [])) || [];
  const assigned: any[] = (await queryDB("SELECT employee_code FROM employee_company_assignments").catch(() => [])) || [];
  let max = 0;
  let width = 4;
  for (const v of [...employees.map((e) => e.employee_id), ...assigned.map((a) => a.employee_code)]) {
    const m = String(v || "").toUpperCase().match(new RegExp(`^${prefix}-(\\d+)$`));
    if (m) {
      max = Math.max(max, Number(m[1]));
      width = Math.max(width, m[1].length);
    }
  }
  return { code: `${prefix}-${String(max + 1).padStart(width, "0")}`, prefix };
}

// Company Transfer (an HR Action, HROperationsRoutes.ts): the Employee now
// belongs to the new company with a new Employee ID; all their records move
// with them (they're keyed by the Employee). Their login follows: access to
// the new company becomes their default, and the old one is dropped unless
// they still work there as well.
export async function applyCompanyTransfer(queryDB: QueryDB, employeeId: number, companyId: number, employeeCode: string | null) {
  const emp = ((await queryDB("SELECT * FROM all_employees WHERE id = ?", [employeeId])) || []).find((e: any) => Number(e.id) === employeeId);
  if (!emp) return;
  const oldCompany = Number(emp.company_id ?? DEFAULT_COMPANY_ID);
  if (oldCompany === companyId) return;
  const code = employeeCode || (await nextEmployeeCode(queryDB, companyId)).code;
  await queryDB("UPDATE all_employees SET company_id = ?, employee_id = ? WHERE id = ?", [companyId, code, employeeId]);
  // Working in the new company as an extra is now simply their company.
  const asg: any[] = ((await queryDB("SELECT * FROM employee_company_assignments WHERE employee_id = ?", [employeeId])) || []).filter(
    (r: any) => Number(r.employee_id) === employeeId
  );
  for (const r of asg) if (Number(r.company_id) === companyId) await queryDB("UPDATE employee_company_assignments SET is_active = ? WHERE id = ?", [0, Number(r.id)]);
  if (emp.user_id) {
    const uid = Number(emp.user_id);
    const acc: any[] = ((await queryDB("SELECT * FROM user_company_access WHERE user_id = ?", [uid])) || []).filter((r: any) => Number(r.user_id) === uid);
    const stillOld = asg.some((r) => Number(r.company_id) === oldCompany && Number(r.is_active ?? 1) === 1);
    for (const r of acc) {
      if (Number(r.company_id) === oldCompany && !stillOld) await queryDB("DELETE FROM user_company_access WHERE id = ?", [Number(r.id)]);
      else await queryDB("UPDATE user_company_access SET is_default = ? WHERE id = ?", [Number(r.company_id) === companyId ? 1 : 0, Number(r.id)]);
    }
    if (!acc.some((r) => Number(r.company_id) === companyId))
      await queryDB("INSERT INTO user_company_access (user_id, company_id, is_default) VALUES (?, ?, ?)", [uid, companyId, 1]);
    invalidateCompanyAccess(uid);
  }
}

// ---------------------------------------------------------------------------
// Workspaces (one per group) — used before sign-in
// ---------------------------------------------------------------------------

// Every table is kept inside its group (companyScope.ts, steps 2–4), so other
// workspaces may sign in. Set to false to close them again (the original
// workspace is never affected).
export const OTHER_WORKSPACES_CAN_SIGN_IN = true;

const WORKSPACE_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const RESERVED_WORKSPACES = new Set(["www", "api", "admin", "app", "login", "mail", "static"]);
export const normalizeWorkspace = (v: any) => String(v || "").trim().toLowerCase();

export async function findWorkspace(queryDB: QueryDB, code: string): Promise<any | null> {
  const want = normalizeWorkspace(code);
  if (!want) return null;
  const rows: any[] = (await queryDB("SELECT * FROM company_groups").catch(() => [])) || [];
  return rows.find((g) => normalizeWorkspace(g.workspace_code) === want && Number(g.is_active ?? 1) === 1) || null;
}

// Checked by POST /api/auth/login when the app sends a workspace: the account
// must belong to that workspace's group. Returns an error message, or null.
export async function checkWorkspaceLogin(queryDB: QueryDB, workspace: any, user: any): Promise<{ status: number; error: string } | null> {
  const groupId = Number(user.group_id ?? DEFAULT_GROUP_ID);
  const closed = groupId !== DEFAULT_GROUP_ID && !OTHER_WORKSPACES_CAN_SIGN_IN;
  // Older app builds send no workspace — only the original workspace's
  // accounts can sign in that way; everyone else types their workspace first
  // (which also keeps a switched-off workspace closed).
  if (workspace === undefined || workspace === null || workspace === "") {
    if (groupId === DEFAULT_GROUP_ID) return null;
    return closed
      ? { status: 403, error: "This workspace is still being set up. Sign-in opens once its data is ready." }
      : { status: 400, error: "Enter your workspace first, then sign in." };
  }
  const g = await findWorkspace(queryDB, workspace);
  if (!g) return { status: 400, error: "This workspace wasn't found. Check the workspace name." };
  if (Number(user.group_id ?? DEFAULT_GROUP_ID) !== Number(g.id)) return { status: 400, error: "Invalid login ID or password" };
  if (Number(g.id) !== DEFAULT_GROUP_ID && !OTHER_WORKSPACES_CAN_SIGN_IN)
    return { status: 403, error: "This workspace is still being set up. Sign-in opens once its data is ready." };
  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerCompanyRoutes(app: Express, deps: CompanyRouteDeps) {
  const { authenticateToken, requireSuperAdmin, queryDB, getAdminModules } = deps;
  const fail = (res: any, err: any, status = 500) => res.status(err?.statusCode || status).json({ error: err?.message || String(err) });
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
  const lite = (c: any) => ({
    id: Number(c.id),
    group_id: Number(c.group_id),
    name: c.name,
    short_code: c.short_code,
    is_mother: Number(c.is_mother) === 1,
    address: c.address || null,
    phone: c.phone || null,
    email: c.email || null,
    website: c.website || null,
    has_logo: !!c.logo_mime,
    is_active: Number(c.is_active ?? 1) === 1,
    shared_settings: sharedKindsOf(c, Number(c.is_mother) === 1)
  });
  const groupOf = async (groupId: number) => {
    const rows: any[] = (await queryDB("SELECT * FROM company_groups").catch(() => [])) || [];
    const g = rows.find((r) => Number(r.id) === groupId);
    return g
      ? { id: Number(g.id), name: g.name, short_name: g.short_name || null, workspace_code: g.workspace_code || null }
      : { id: groupId, name: "", short_name: null, workspace_code: null };
  };

  // The companies this account can switch between.
  app.get("/api/companies/mine", authenticateToken, async (req: any, res) => {
    try {
      const info = await loadCompanyAccess(queryDB, req.user);
      const companies = (await companiesOfGroup(queryDB, info.groupId)).filter((c) => info.allowed.includes(Number(c.id))).map(lite);
      companies.sort((a, b) => Number(b.is_mother) - Number(a.is_mother) || a.name.localeCompare(b.name));
      res.json({ group: await groupOf(info.groupId), companies, default_company_id: info.defaultId, active_company_id: activeCompanyId() });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/companies/mine/default", authenticateToken, async (req: any, res) => {
    try {
      const id = Number(req.body?.company_id);
      const info = await loadCompanyAccess(queryDB, req.user);
      if (!info.allowed.includes(id)) throw bad("You don't have access to that company.", 403);
      const rows: any[] = ((await queryDB("SELECT * FROM user_company_access WHERE user_id = ?", [req.user.id])) || []).filter(
        (r: any) => Number(r.user_id) === Number(req.user.id)
      );
      for (const r of rows) await queryDB("UPDATE user_company_access SET is_default = ? WHERE id = ?", [Number(r.company_id) === id ? 1 : 0, Number(r.id)]);
      if (!rows.some((r) => Number(r.company_id) === id)) await queryDB("INSERT INTO user_company_access (user_id, company_id, is_default) VALUES (?, ?, ?)", [req.user.id, id, 1]);
      invalidateCompanyAccess(Number(req.user.id));
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Next Employee ID for the active company: its short code + the next number
  // after the highest one already used with that prefix (CPL-0007 -> CPL-0008).
  app.get("/api/companies/next-employee-code", authenticateToken, async (req: any, res) => {
    try {
      const companyId = req.query.company_id ? Number(req.query.company_id) : activeCompanyId();
      const own = (await companiesOfGroup(queryDB, (await loadCompanyAccess(queryDB, req.user)).groupId)).some((c) => Number(c.id) === companyId);
      if (!own) throw bad("Company not found.", 404);
      res.json(await nextEmployeeCode(queryDB, companyId));
    } catch (err) {
      fail(res, err);
    }
  });

  // Every company of the account's group (pickers for transfers / assignments).
  app.get("/api/companies/group", authenticateToken, async (req: any, res) => {
    try {
      const info = await loadCompanyAccess(queryDB, req.user);
      res.json(
        (await companiesOfGroup(queryDB, info.groupId))
          .filter((c) => Number(c.is_active ?? 1) === 1)
          .map((c) => ({ id: Number(c.id), name: c.name, short_code: c.short_code, is_mother: Number(c.is_mother) === 1 }))
      );
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- Working in another company as well (additional assignment) ----------------

  const hrGate = async (req: any, res: any, next: any) => {
    if (req.user?.role === "superadmin") return next();
    const mods = await getAdminModules(Number(req.user?.id)).catch(() => [] as string[]);
    if (mods.includes("hr_operations") || mods.includes("employees")) return next();
    res.status(403).json({ error: "You don't have access to this section." });
  };

  app.get("/api/companies/assignments", authenticateToken, hrGate, async (req: any, res) => {
    try {
      const empId = Number(req.query.employee_id);
      const info = await loadCompanyAccess(queryDB, req.user);
      const companies = await companiesOfGroup(queryDB, info.groupId);
      const byId = new Map(companies.map((c) => [Number(c.id), c]));
      const emp = ((await queryDB("SELECT * FROM all_employees WHERE id = ?", [empId])) || []).find((e: any) => Number(e.id) === empId);
      if (!emp) throw bad("Employee not found.", 404);
      const rows: any[] = ((await queryDB("SELECT * FROM employee_company_assignments WHERE employee_id = ?", [empId])) || []).filter(
        (r: any) => Number(r.employee_id) === empId && byId.has(Number(r.company_id))
      );
      const home = byId.get(Number(emp.company_id ?? DEFAULT_COMPANY_ID));
      res.json({
        home_company: home ? { id: Number(home.id), name: home.name, short_code: home.short_code } : null,
        assignments: rows.map((r) => ({
          id: Number(r.id),
          company_id: Number(r.company_id),
          company_name: byId.get(Number(r.company_id))?.name || "—",
          short_code: byId.get(Number(r.company_id))?.short_code || "",
          employee_code: r.employee_code || null,
          designation: r.designation || null,
          department: r.department || null,
          start_date: r.start_date ? String(r.start_date instanceof Date ? r.start_date.toISOString() : r.start_date).slice(0, 10) : null,
          end_date: r.end_date ? String(r.end_date instanceof Date ? r.end_date.toISOString() : r.end_date).slice(0, 10) : null,
          is_active: Number(r.is_active ?? 1) === 1,
          note: r.note || null
        }))
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Their login may then switch into that company too.
  async function syncAssignmentAccess(emp: any, companyId: number, active: boolean) {
    if (!emp?.user_id) return;
    const uid = Number(emp.user_id);
    const acc: any[] = ((await queryDB("SELECT * FROM user_company_access WHERE user_id = ?", [uid])) || []).filter((r: any) => Number(r.user_id) === uid);
    const has = acc.find((r) => Number(r.company_id) === companyId);
    if (active && !has) await queryDB("INSERT INTO user_company_access (user_id, company_id, is_default) VALUES (?, ?, ?)", [uid, companyId, 0]);
    if (!active && has && Number(emp.company_id ?? DEFAULT_COMPANY_ID) !== companyId) await queryDB("DELETE FROM user_company_access WHERE id = ?", [Number(has.id)]);
    invalidateCompanyAccess(uid);
  }

  app.post("/api/companies/assignments", authenticateToken, hrGate, async (req: any, res) => {
    try {
      const b = req.body || {};
      const empId = Number(b.employee_id);
      const companyId = Number(b.company_id);
      const info = await loadCompanyAccess(queryDB, req.user);
      const target = (await companiesOfGroup(queryDB, info.groupId)).find((c) => Number(c.id) === companyId && Number(c.is_active ?? 1) === 1);
      if (!target) throw bad("Pick a company of your group.");
      const emp = ((await queryDB("SELECT * FROM all_employees WHERE id = ?", [empId])) || []).find((e: any) => Number(e.id) === empId);
      if (!emp) throw bad("Employee not found.", 404);
      if (Number(emp.company_id ?? DEFAULT_COMPANY_ID) === companyId) throw bad(`${emp.name} already belongs to ${target.name}.`);
      const s = (v: any, n: number) => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, n));
      const code = s(b.employee_code, 50) || (await nextEmployeeCode(queryDB, companyId)).code;
      const existing = ((await queryDB("SELECT * FROM employee_company_assignments WHERE employee_id = ?", [empId])) || []).find(
        (r: any) => Number(r.employee_id) === empId && Number(r.company_id) === companyId
      );
      const vals = [code, s(b.designation, 150), s(b.department, 150), s(b.start_date, 10), s(b.end_date, 10), s(b.note, 500)];
      if (existing)
        await queryDB("UPDATE employee_company_assignments SET employee_code = ?, designation = ?, department = ?, start_date = ?, end_date = ?, note = ?, is_active = ? WHERE id = ?", [
          ...vals,
          1,
          Number(existing.id)
        ]);
      else
        await queryDB(
          "INSERT INTO employee_company_assignments (employee_id, company_id, employee_code, designation, department, start_date, end_date, note, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [empId, companyId, ...vals, 1, Number(req.user.id)]
        );
      await syncAssignmentAccess(emp, companyId, true);
      res.json({ success: true, employee_code: code });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/companies/assignments/:id/end", authenticateToken, hrGate, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const row = ((await queryDB("SELECT * FROM employee_company_assignments WHERE id = ?", [id])) || []).find((r: any) => Number(r.id) === id);
      if (!row) throw bad("Not found.", 404);
      const info = await loadCompanyAccess(queryDB, req.user);
      if (!(await companiesOfGroup(queryDB, info.groupId)).some((c) => Number(c.id) === Number(row.company_id))) throw bad("Not found.", 404);
      const end = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.end_date || "")) ? String(req.body.end_date) : new Date().toISOString().slice(0, 10);
      await queryDB("UPDATE employee_company_assignments SET is_active = ?, end_date = ? WHERE id = ?", [0, end, id]);
      const emp = ((await queryDB("SELECT * FROM all_employees WHERE id = ?", [Number(row.employee_id)])) || [])[0];
      await syncAssignmentAccess(emp, Number(row.company_id), false);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/companies/:id/logo", authenticateToken, async (req: any, res) => {
    try {
      const rows: any[] = (await queryDB("SELECT * FROM companies WHERE id = ?", [Number(req.params.id)])) || [];
      const c = rows.find((r) => Number(r.id) === Number(req.params.id));
      const info = await loadCompanyAccess(queryDB, req.user);
      if (!c || !c.logo_mime || Number(c.group_id) !== info.groupId) throw bad("No logo.", 404);
      res.setHeader("Content-Type", c.logo_mime);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.send(Buffer.isBuffer(c.logo_data) ? c.logo_data : Buffer.from(c.logo_data || ""));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- System Management (Superadmin) ----------------

  const myGroup = async (req: any) => (await loadCompanyAccess(queryDB, req.user)).groupId;

  app.get("/api/system/companies", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const groupId = await myGroup(req);
      const companies = await companiesOfGroup(queryDB, groupId);
      const [employees, access, assignments] = await Promise.all([
        // Counts for every company of the group, whichever one is selected.
        queryDB("/*unscoped*/ SELECT * FROM all_employees").catch(() => []),
        queryDB("SELECT * FROM user_company_access").catch(() => []),
        queryDB("SELECT * FROM employee_company_assignments").catch(() => [])
      ]);
      const me: any[] = (await queryDB("SELECT * FROM users WHERE id = ?", [req.user.id]).catch(() => [])) || [];
      res.json({
        group: await groupOf(groupId),
        is_platform_admin: Number(me.find((u) => Number(u.id) === Number(req.user.id))?.is_platform_admin || 0) === 1,
        share_kinds: SHARE_KINDS.map((k) => ({ key: k.key, label: k.label })),
        companies: companies
          .map((c) => {
            const id = Number(c.id);
            return {
              ...lite(c),
              employee_count: (employees as any[]).filter((e) => Number(e.company_id ?? DEFAULT_COMPANY_ID) === id && Number(e.is_active ?? 1) !== 0).length,
              additional_employee_count: (assignments as any[]).filter((a) => Number(a.company_id) === id && Number(a.is_active ?? 1) === 1).length,
              user_count: (access as any[]).filter((a) => Number(a.company_id) === id).length
            };
          })
          .sort((a, b) => Number(b.is_mother) - Number(a.is_mother) || a.name.localeCompare(b.name))
      });
    } catch (err) {
      fail(res, err);
    }
  });

  async function cleanCompany(b: any, groupId: number, selfId: number | null) {
    const name = String(b?.name || "").trim().slice(0, 200);
    if (!name) throw bad("Enter the company name.");
    const code = String(b?.short_code || "").trim().toUpperCase();
    if (!CODE_RE.test(code)) throw bad("Short code: 2–8 capital letters or digits, starting with a letter (e.g. CHL). It prefixes Employee IDs and letter numbers.");
    const others = (await companiesOfGroup(queryDB, groupId)).filter((c) => Number(c.id) !== selfId);
    if (others.some((c) => String(c.short_code).toUpperCase() === code)) throw bad(`Another company already uses the code ${code}.`);
    const s = (v: any, n: number) => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, n));
    let logo: { mime: string; data: Buffer } | null | undefined;
    if (b?.logo === null) logo = null;
    else if (b?.logo?.data) {
      const mime = String(b.logo.mime || "image/png");
      if (!/^image\//.test(mime)) throw bad("The logo must be an image.");
      const data = Buffer.from(String(b.logo.data).replace(/^data:[^,]*,/, ""), "base64");
      if (data.length > MAX_LOGO_BYTES) throw bad("The logo is larger than 2 MB.");
      logo = { mime, data };
    }
    return {
      name,
      short_code: code,
      is_mother: b?.is_mother ? 1 : 0,
      address: s(b?.address, 500),
      phone: s(b?.phone, 60),
      email: s(b?.email, 150),
      website: s(b?.website, 150),
      is_active: b?.is_active === undefined ? 1 : b.is_active ? 1 : 0,
      logo,
      // Kinds of settings used from the mother company (see SHARE_KINDS).
      shared_settings: Array.isArray(b?.shared_settings)
        ? JSON.stringify(b.shared_settings.filter((k: any) => SHARE_KINDS.some((x) => x.key === k)))
        : undefined
    };
  }

  // Only one mother company per group.
  async function setMother(groupId: number, id: number) {
    for (const c of await companiesOfGroup(queryDB, groupId))
      if (Number(c.id) !== id && Number(c.is_mother) === 1) await queryDB("UPDATE companies SET is_mother = ? WHERE id = ?", [0, Number(c.id)]);
  }

  app.post("/api/system/companies", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const groupId = await myGroup(req);
      const c = await cleanCompany(req.body, groupId, null);
      const r: any = await queryDB(
        "INSERT INTO companies (group_id, name, short_code, is_mother, address, phone, email, website, is_active, logo_mime, logo_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [groupId, c.name, c.short_code, c.is_mother, c.address, c.phone, c.email, c.website, c.is_active, c.logo?.mime || null, c.logo?.data || null]
      );
      const id = Number(r.insertId);
      if (c.shared_settings !== undefined) await queryDB("UPDATE companies SET shared_settings = ? WHERE id = ?", [c.shared_settings, id]);
      if (c.is_mother) await setMother(groupId, id);
      invalidateCompanyAccess();
      res.json({ success: true, id });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/system/companies/:id", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const groupId = await myGroup(req);
      const id = Number(req.params.id);
      const cur = (await companiesOfGroup(queryDB, groupId)).find((x) => Number(x.id) === id);
      if (!cur) throw bad("Company not found.", 404);
      const c = await cleanCompany(req.body, groupId, id);
      if (Number(cur.is_mother) === 1 && !c.is_mother) throw bad("Make another company the mother company first.");
      if (!c.is_active && (c.is_mother || Number(cur.is_mother) === 1)) throw bad("The mother company can't be deactivated.");
      await queryDB("UPDATE companies SET name = ?, short_code = ?, is_mother = ?, address = ?, phone = ?, email = ?, website = ?, is_active = ? WHERE id = ?", [
        c.name,
        c.short_code,
        c.is_mother,
        c.address,
        c.phone,
        c.email,
        c.website,
        c.is_active,
        id
      ]);
      if (c.logo !== undefined) await queryDB("UPDATE companies SET logo_mime = ?, logo_data = ? WHERE id = ?", [c.logo?.mime || null, c.logo?.data || null, id]);
      if (c.shared_settings !== undefined) await queryDB("UPDATE companies SET shared_settings = ? WHERE id = ?", [c.shared_settings, id]);
      if (c.is_mother) await setMother(groupId, id);
      invalidateCompanyAccess();
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Who may enter which company, and what Module Access they hold in each.
  app.get("/api/system/company-access", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const groupId = await myGroup(req);
      const groupCompanies = await companiesOfGroup(queryDB, groupId);
      const companyIds = new Set(groupCompanies.map((c) => Number(c.id)));
      // An account with no rows yet (hasn't signed in since multi-company)
      // works in the mother company — show it that way.
      const motherId = Number((groupCompanies.find((c) => Number(c.is_mother) === 1) || groupCompanies[0])?.id || DEFAULT_COMPANY_ID);
      const [users, access, perms] = await Promise.all([
        queryDB("SELECT * FROM users").catch(() => []),
        queryDB("SELECT * FROM user_company_access").catch(() => []),
        queryDB("SELECT * FROM admin_module_permissions").catch(() => [])
      ]);
      res.json({
        users: (users as any[])
          .filter((u) => Number(u.group_id ?? DEFAULT_GROUP_ID) === groupId)
          .map((u) => {
            const mine = (access as any[]).filter((a) => Number(a.user_id) === Number(u.id) && companyIds.has(Number(a.company_id)));
            const modules: Record<number, number> = {};
            for (const p of perms as any[])
              if (Number(p.user_id) === Number(u.id)) {
                const cid = Number(p.company_id ?? DEFAULT_COMPANY_ID);
                modules[cid] = (modules[cid] || 0) + 1;
              }
            return {
              id: Number(u.id),
              name: u.name,
              email: u.email || u.username || null,
              role: u.role,
              company_ids: u.role === "superadmin" ? [...companyIds] : mine.length ? mine.map((a) => Number(a.company_id)) : [motherId],
              default_company_id: Number(mine.find((a) => Number(a.is_default) === 1)?.company_id || 0) || (mine.length ? Number(mine[0].company_id) : motherId),
              module_counts: modules
            };
          })
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/system/company-access/:userId", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const groupId = await myGroup(req);
      const userId = Number(req.params.userId);
      const companyIds = new Set((await companiesOfGroup(queryDB, groupId)).map((c) => Number(c.id)));
      const want: number[] = (Array.isArray(req.body?.company_ids) ? req.body.company_ids : []).map(Number).filter((id: number) => companyIds.has(id));
      if (!want.length) throw bad("An account needs at least one company.");
      let def = Number(req.body?.default_company_id) || want[0];
      if (!want.includes(def)) def = want[0];
      const rows: any[] = ((await queryDB("SELECT * FROM user_company_access WHERE user_id = ?", [userId])) || []).filter(
        (r: any) => Number(r.user_id) === userId && companyIds.has(Number(r.company_id))
      );
      for (const r of rows) {
        if (!want.includes(Number(r.company_id))) await queryDB("DELETE FROM user_company_access WHERE id = ?", [Number(r.id)]);
        else await queryDB("UPDATE user_company_access SET is_default = ? WHERE id = ?", [Number(r.company_id) === def ? 1 : 0, Number(r.id)]);
      }
      for (const id of want)
        if (!rows.some((r) => Number(r.company_id) === id))
          await queryDB("INSERT INTO user_company_access (user_id, company_id, is_default) VALUES (?, ?, ?)", [userId, id, id === def ? 1 : 0]);
      invalidateCompanyAccess(userId);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Shared-service HR: give an account the same Module Access (and action
  // layers) in other companies as they already have in one.
  app.post("/api/system/company-access/:userId/copy-permissions", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const groupId = await myGroup(req);
      const userId = Number(req.params.userId);
      const companyIds = new Set((await companiesOfGroup(queryDB, groupId)).map((c) => Number(c.id)));
      const from = Number(req.body?.from_company_id);
      const to: number[] = (Array.isArray(req.body?.to_company_ids) ? req.body.to_company_ids : []).map(Number).filter((id: number) => companyIds.has(id) && id !== from);
      if (!companyIds.has(from) || !to.length) throw bad("Pick the company to copy from and at least one company to copy to.");
      const perms: any[] = ((await queryDB("SELECT * FROM admin_module_permissions")) || []).filter((p: any) => Number(p.user_id) === userId);
      const layers: any[] = ((await queryDB("SELECT * FROM admin_module_permission_layers").catch(() => [])) || []).filter((p: any) => Number(p.user_id) === userId);
      const src = perms.filter((p) => Number(p.company_id ?? DEFAULT_COMPANY_ID) === from);
      const srcLayers = layers.filter((p) => Number(p.company_id ?? DEFAULT_COMPANY_ID) === from);
      for (const cid of to) {
        for (const p of perms) if (Number(p.company_id ?? DEFAULT_COMPANY_ID) === cid) await queryDB("DELETE FROM admin_module_permissions WHERE id = ?", [Number(p.id)]);
        for (const l of layers) if (Number(l.company_id ?? DEFAULT_COMPANY_ID) === cid) await queryDB("DELETE FROM admin_module_permission_layers WHERE id = ?", [Number(l.id)]);
        for (const p of src) await queryDB("INSERT INTO admin_module_permissions (user_id, module_key, company_id) VALUES (?, ?, ?)", [userId, p.module_key, cid]);
        for (const l of srcLayers)
          await queryDB("INSERT INTO admin_module_permission_layers (user_id, module_key, layer_key, company_id) VALUES (?, ?, ?, ?)", [userId, l.module_key, l.layer_key, cid]);
        // Copying access implies they may enter that company.
        const acc: any[] = ((await queryDB("SELECT * FROM user_company_access WHERE user_id = ?", [userId])) || []).filter((r: any) => Number(r.user_id) === userId);
        if (!acc.some((r) => Number(r.company_id) === cid)) await queryDB("INSERT INTO user_company_access (user_id, company_id, is_default) VALUES (?, ?, ?)", [userId, cid, 0]);
      }
      invalidateCompanyAccess(userId);
      res.json({ success: true, modules: src.length, companies: to.length });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- Workspace (public, before sign-in) ----------------

  const workspaceLite = (g: any) => ({
    id: Number(g.id),
    code: g.workspace_code,
    name: g.name,
    short_name: g.short_name || null,
    tagline: g.tagline || null,
    has_logo: !!g.logo_mime
  });

  app.get("/api/public/workspaces/:code", async (req: any, res) => {
    try {
      const g = await findWorkspace(queryDB, req.params.code);
      if (!g) throw bad("This workspace wasn't found. Check the workspace name.", 404);
      res.json(workspaceLite(g));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/public/workspaces/:code/logo", async (req: any, res) => {
    try {
      const g = await findWorkspace(queryDB, req.params.code);
      if (!g || !g.logo_mime) throw bad("No logo.", 404);
      res.setHeader("Content-Type", g.logo_mime);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(Buffer.isBuffer(g.logo_data) ? g.logo_data : Buffer.from(g.logo_data || ""));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- Platform (the system owner) ----------------

  const requirePlatformAdmin = async (req: any, res: any, next: any) => {
    const rows: any[] = (await queryDB("SELECT * FROM users WHERE id = ?", [req.user?.id]).catch(() => [])) || [];
    const u = rows.find((r) => Number(r.id) === Number(req.user?.id));
    if (!u || Number(u.is_platform_admin) !== 1) return res.status(403).json({ error: "Only the system owner can manage workspaces." });
    next();
  };

  const cleanLogo = (v: any): { mime: string; data: Buffer } | null | undefined => {
    if (v === null) return null;
    if (!v?.data) return undefined;
    const mime = String(v.mime || "image/png");
    if (!/^image\//.test(mime)) throw bad("The logo must be an image.");
    const data = Buffer.from(String(v.data).replace(/^data:[^,]*,/, ""), "base64");
    if (data.length > MAX_LOGO_BYTES) throw bad("The logo is larger than 2 MB.");
    return { mime, data };
  };
  async function cleanWorkspace(b: any, selfId: number | null) {
    const name = String(b?.name || "").trim().slice(0, 150);
    if (!name) throw bad("Enter the group name.");
    const code = normalizeWorkspace(b?.workspace_code);
    if (!WORKSPACE_RE.test(code) || RESERVED_WORKSPACES.has(code))
      throw bad("Workspace: 3–40 small letters, digits or dashes, starting with a letter (e.g. credence). People type this before signing in.");
    const rows: any[] = (await queryDB("SELECT * FROM company_groups")) || [];
    if (rows.some((g) => Number(g.id) !== selfId && normalizeWorkspace(g.workspace_code) === code)) throw bad(`The workspace "${code}" is already taken.`);
    return {
      name,
      code,
      short_name: b?.short_name ? String(b.short_name).trim().slice(0, 50) : null,
      tagline: b?.tagline ? String(b.tagline).trim().slice(0, 200) : null,
      is_active: b?.is_active === undefined ? 1 : b.is_active ? 1 : 0,
      logo: cleanLogo(b?.logo)
    };
  }

  app.get("/api/platform/workspaces", authenticateToken, requirePlatformAdmin, async (_req: any, res) => {
    try {
      const [groups, companies, users] = await Promise.all([
        queryDB("SELECT * FROM company_groups"),
        queryDB("SELECT * FROM companies").catch(() => []),
        // Every workspace's accounts — the system owner's view spans groups.
        queryDB("/*unscoped*/ SELECT * FROM users").catch(() => [])
      ]);
      res.json({
        can_sign_in_other_workspaces: OTHER_WORKSPACES_CAN_SIGN_IN,
        workspaces: (groups as any[])
          .map((g) => {
            const id = Number(g.id);
            const cs = (companies as any[]).filter((c) => Number(c.group_id) === id);
            return {
              ...workspaceLite(g),
              is_active: Number(g.is_active ?? 1) === 1,
              can_sign_in: id === DEFAULT_GROUP_ID || OTHER_WORKSPACES_CAN_SIGN_IN,
              companies: cs
                .map((c) => ({ id: Number(c.id), name: c.name, short_code: c.short_code, is_mother: Number(c.is_mother) === 1 }))
                .sort((a, b) => Number(b.is_mother) - Number(a.is_mother) || a.name.localeCompare(b.name)),
              superadmins: (users as any[])
                .filter((u) => Number(u.group_id ?? DEFAULT_GROUP_ID) === id && u.role === "superadmin")
                .map((u) => ({ id: Number(u.id), name: u.name, email: u.email })),
              user_count: (users as any[]).filter((u) => Number(u.group_id ?? DEFAULT_GROUP_ID) === id).length
            };
          })
          .sort((a, b) => a.id - b.id)
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // New workspace = group + its companies (first one is the mother) + its own
  // Superadmin, who then runs it from Admin Panel -> Companies.
  app.post("/api/platform/workspaces", authenticateToken, requirePlatformAdmin, async (req: any, res) => {
    try {
      const w = await cleanWorkspace(req.body, null);
      const list: any[] = (Array.isArray(req.body?.companies) ? req.body.companies : []).filter((c: any) => String(c?.name || "").trim());
      if (!list.length) throw bad("Add at least the mother company.");
      const codes = new Set<string>();
      const companies = list.map((c, i) => {
        const name = String(c.name).trim().slice(0, 200);
        const code = String(c.short_code || "").trim().toUpperCase();
        if (!CODE_RE.test(code)) throw bad(`Short code for "${name}": 2–8 capital letters or digits, starting with a letter.`);
        if (codes.has(code)) throw bad(`The code ${code} is used twice.`);
        codes.add(code);
        return { name, code, is_mother: i === 0 ? 1 : 0 };
      });
      const admin = req.body?.admin || {};
      const adminName = String(admin.name || "").trim().slice(0, 100);
      const adminEmail = String(admin.email || "").trim().toLowerCase().slice(0, 150);
      const adminPassword = String(admin.password || "");
      if (!adminName || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) throw bad("Enter the name and a valid email of this workspace's Superadmin.");
      if (adminPassword.length < 8) throw bad("The Superadmin's password must be at least 8 characters.");
      const existing: any[] = (await queryDB("SELECT * FROM users WHERE email = ?", [adminEmail])) || [];
      if (existing.some((u) => String(u.email || "").toLowerCase() === adminEmail)) throw bad("An account with that email already exists.");

      const g: any = await queryDB("INSERT INTO company_groups (name, short_name, workspace_code, tagline, is_active, logo_mime, logo_data) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        w.name,
        w.short_name,
        w.code,
        w.tagline,
        w.is_active,
        w.logo?.mime || null,
        w.logo?.data || null
      ]);
      const groupId = Number(g.insertId);
      const ids: number[] = [];
      for (const c of companies) {
        const r: any = await queryDB("INSERT INTO companies (group_id, name, short_code, is_mother) VALUES (?, ?, ?, ?)", [groupId, c.name, c.code, c.is_mother]);
        ids.push(Number(r.insertId));
      }
      const hash = await bcrypt.hash(adminPassword, 10);
      const u: any = await queryDB("INSERT INTO users (name, email, password_hash, role, group_id) VALUES (?, ?, ?, 'superadmin', ?)", [adminName, adminEmail, hash, groupId]);
      await queryDB("INSERT INTO user_company_access (user_id, company_id, is_default) VALUES (?, ?, ?)", [Number(u.insertId), ids[0], 1]);
      await queryDB(SEED_GROUP_DEFAULTS).catch(() => {});
      res.json({ success: true, id: groupId, company_ids: ids, superadmin_id: Number(u.insertId) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/platform/workspaces/:id", authenticateToken, requirePlatformAdmin, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const rows: any[] = (await queryDB("SELECT * FROM company_groups")) || [];
      if (!rows.some((g) => Number(g.id) === id)) throw bad("Workspace not found.", 404);
      const w = await cleanWorkspace(req.body, id);
      if (id === DEFAULT_GROUP_ID && !w.is_active) throw bad("Your own workspace can't be switched off.");
      await queryDB("UPDATE company_groups SET name = ?, short_name = ?, workspace_code = ?, tagline = ?, is_active = ? WHERE id = ?", [
        w.name,
        w.short_name,
        w.code,
        w.tagline,
        w.is_active,
        id
      ]);
      if (w.logo !== undefined) await queryDB("UPDATE company_groups SET logo_mime = ?, logo_data = ? WHERE id = ?", [w.logo?.mime || null, w.logo?.data || null, id]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });
}
