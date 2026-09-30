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
import { DEFAULT_COMPANY_ID, DEFAULT_GROUP_ID, activeCompanyId, type CompanyContext } from "./companyContext";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface CompanyRouteDeps {
  authenticateToken: any;
  requireSuperAdmin: any;
  queryDB: QueryDB;
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
  await run("all_employees.company_id", "ALTER TABLE all_employees ADD COLUMN company_id INT NOT NULL DEFAULT 1", ["ER_DUP_FIELDNAME"]);
  await run("all_employees index", "ALTER TABLE all_employees ADD INDEX idx_employee_company (company_id)", ["ER_DUP_KEYNAME"]);

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

// ---------------------------------------------------------------------------
// Resolving the active company for a request
// ---------------------------------------------------------------------------

interface AccessInfo {
  at: number;
  groupId: number;
  allowed: number[];
  defaultId: number;
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
    // First visit since multi-company: the account works in its group's
    // mother company, exactly as before.
    await queryDB("INSERT INTO user_company_access (user_id, company_id, is_default) VALUES (?, ?, ?)", [user.id, Number(mother.id), 1]).catch(() => {});
    allowed = [Number(mother.id)];
    defaultId = Number(mother.id);
  }
  if (role === "superadmin") allowed = companies.map((c) => Number(c.id));
  if (!allowed.length) allowed = [mother ? Number(mother.id) : DEFAULT_COMPANY_ID];
  if (!defaultId || !allowed.includes(defaultId)) defaultId = allowed.includes(Number(mother?.id)) ? Number(mother.id) : allowed[0];
  const info = { at: Date.now(), groupId, allowed, defaultId };
  accessCache.set(Number(user.id), info);
  return info;
}

// The company this request works in: the one asked for (X-Company-Id), if the
// account may enter it, else their default company.
export async function resolveCompanyContext(queryDB: QueryDB, user: { id: number; role?: string }, requested: any): Promise<CompanyContext> {
  const info = await loadCompanyAccess(queryDB, user);
  const want = Number(Array.isArray(requested) ? requested[0] : requested);
  return { companyId: want && info.allowed.includes(want) ? want : info.defaultId, groupId: info.groupId };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerCompanyRoutes(app: Express, deps: CompanyRouteDeps) {
  const { authenticateToken, requireSuperAdmin, queryDB } = deps;
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
    is_active: Number(c.is_active ?? 1) === 1
  });
  const groupOf = async (groupId: number) => {
    const rows: any[] = (await queryDB("SELECT * FROM company_groups").catch(() => [])) || [];
    const g = rows.find((r) => Number(r.id) === groupId);
    return g ? { id: Number(g.id), name: g.name, short_name: g.short_name || null } : { id: groupId, name: "", short_name: null };
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
        queryDB("SELECT * FROM all_employees").catch(() => []),
        queryDB("SELECT * FROM user_company_access").catch(() => []),
        queryDB("SELECT * FROM employee_company_assignments").catch(() => [])
      ]);
      res.json({
        group: await groupOf(groupId),
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
      logo
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
}
