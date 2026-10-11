/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// New Joiner Onboarding (self-service) — HR Operations -> Onboarding ->
// "New Joiners". When a candidate is hired, HR opens an application here: a
// temporary login (ONB-0001 + a password shown to HR once) is created for
// the joiner, who signs in to a restricted "My Onboarding" page, fills in
// their details and uploads documents. Until HR approves, the person is NOT
// an Employee: nothing lives in all_employees, so they never show up in
// pickers, headcount, payroll or attendance.
//
//   onboarding_applications  one per joiner (draft -> submitted -> approved |
//                            rejected (-> submitted again) | cancelled | expired)
//   onboarding_documents     the joiner's uploads, moved to employee_documents
//                            on approval
//
// A login with users.is_onboarding = 1 may only reach the paths in
// onboardingPathAllowed() — authenticateToken (server.ts) refuses everything
// else with 403 ONBOARDING_ONLY.
//
// Permission layers on the hr_operations module, all explicit-only:
//   onboarding_create   open an application / reset the joiner's password
//   onboarding_review   see applications, reject, cancel
//   onboarding_approve  approve (creates the Employee)

import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { Express } from "express";
import { activeCompanyId } from "./companyContext";
import { endAllSessions } from "./SessionSecurity";
import { loadSettings } from "./HROperationsRoutes";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;
type Tx = (fn: (q: QueryDB) => Promise<void>) => Promise<void>;

export const ONBOARDING_LAYERS = ["onboarding_create", "onboarding_review", "onboarding_approve"] as const;
export type OnboardingLayer = (typeof ONBOARDING_LAYERS)[number];

export async function ensureOnboardingSchema(dbPool: any) {
  const columns: [string, string][] = [
    ["is_onboarding", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["must_change_password", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["onboarding_expires_at", "DATETIME NULL"]
  ];
  for (const [name, def] of columns) {
    try {
      await dbPool.query(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
    } catch (err: any) {
      if (err.code !== "ER_DUP_FIELDNAME") console.warn(`⚠️ Could not add users.${name} column: ` + err.message);
    }
  }
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS onboarding_applications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        company_id INT NOT NULL,
        user_id INT NOT NULL,
        candidate_id INT NULL,
        onb_code VARCHAR(20) NOT NULL,
        name VARCHAR(255) NOT NULL,
        designation VARCHAR(255) NULL,
        department_id INT NULL,
        branch_id INT NULL,
        joining_date DATE NULL,
        email VARCHAR(255) NULL,
        phone VARCHAR(60) NULL,
        -- draft -> submitted -> approved | rejected (-> submitted again) | cancelled | expired
        status VARCHAR(20) NOT NULL DEFAULT 'draft',
        data_json MEDIUMTEXT NULL,
        submitted_at DATETIME NULL,
        review_remarks VARCHAR(500) NULL,
        reviewed_by INT NULL,
        reviewed_at DATETIME NULL,
        employee_id INT NULL,
        created_by INT NULL,
        expires_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_onb_code (onb_code),
        KEY idx_onb_company (company_id, status),
        KEY idx_onb_user (user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS onboarding_documents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        application_id INT NOT NULL,
        doc_type VARCHAR(100) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        file_mime VARCHAR(100) NULL,
        file_data LONGBLOB NULL,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_onb_doc (application_id, doc_type),
        FOREIGN KEY (application_id) REFERENCES onboarding_applications(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure onboarding tables exist: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// The restricted token
// ---------------------------------------------------------------------------

// The only API paths an onboarding login may call. Anything else — however
// it is spelt — is refused, so a check here errs on the side of "no".
export function onboardingPathAllowed(method: string, rawUrl: string, userId?: number): boolean {
  const m = String(method || "").toUpperCase();
  let p = String(rawUrl || "").split("?")[0].split("#")[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    return false;
  }
  if (p.includes("..") || p.includes("//") || p.includes("\\") || p.includes(";") || /[\u0000-\u001f]/.test(p)) return false;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p === "/api/auth/me") return m === "GET";
  if (p === "/api/auth/logout") return m === "POST";
  if (p === "/api/profile/password") return m === "PUT";
  if (p === "/api/profile/photo") return m === "GET" || m === "POST";
  // Their own photo only.
  const photo = p.match(/^\/api\/profile\/photo\/(\d+)$/);
  if (photo) return m === "GET" && userId !== undefined && Number(photo[1]) === Number(userId);
  if (p === "/api/onboarding/me" || /^\/api\/onboarding\/me\/[a-z0-9\-/]+$/.test(p)) return ["GET", "POST", "PUT", "DELETE"].includes(m);
  return false;
}

// Is this login an onboarding (temporary) account? Checked on every request,
// so cached briefly; approving / cancelling clears the entry at once.
const onbCache = new Map<number, { onb: boolean; at: number }>();
const ONB_TTL_MS = 30_000;
export async function accountOnboarding(queryDB: QueryDB, userId: number): Promise<boolean> {
  const hit = onbCache.get(userId);
  if (hit && Date.now() - hit.at < ONB_TTL_MS) return hit.onb;
  const rows: any[] | null = await queryDB("/*unscoped*/ SELECT id, is_onboarding FROM users WHERE id = ?", [userId]).catch(() => null);
  // A database hiccup: the token's own claim still decides (authenticateToken).
  if (!rows) return false;
  const row = rows.find((r: any) => Number(r.id) === userId);
  const onb = !!row && Number(row.is_onboarding || 0) === 1;
  onbCache.set(userId, { onb, at: Date.now() });
  return onb;
}
export function forgetOnboarding(userId: number) {
  onbCache.delete(userId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OPEN_STATUSES = ["draft", "submitted", "rejected", "approved"];
const PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function tempPassword(length = 10): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += PASSWORD_CHARS[bytes[i] % PASSWORD_CHARS.length];
  return out;
}

export async function onboardingExpiryDays(queryDB: QueryDB): Promise<number> {
  const settings = await loadSettings(queryDB).catch(() => ({}) as Record<string, string>);
  const n = Math.round(Number(settings.onboarding_expiry_days));
  return Number.isFinite(n) && n >= 1 && n <= 365 ? n : 14;
}

const toDate = (v: any): string | null => {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const clean = (v: any, max = 255) => (v === undefined || v === null || !String(v).trim() ? null : String(v).trim().slice(0, max));

// Next ONB-#### across every company (usernames are unique system-wide).
async function nextOnbCode(q: QueryDB): Promise<string> {
  const [users, apps]: any[][] = await Promise.all([
    q("/*unscoped*/ SELECT username FROM users WHERE username LIKE 'ONB-%'"),
    q("/*unscoped*/ SELECT onb_code FROM onboarding_applications")
  ]);
  let max = 0;
  for (const v of [...(users || []).map((u: any) => u.username), ...(apps || []).map((a: any) => a.onb_code)]) {
    const m = String(v || "").toUpperCase().match(/^ONB-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `ONB-${String(max + 1).padStart(4, "0")}`;
}

function serialize(a: any, lookups: { users: any[]; departments: any[]; branches: any[]; docCounts?: Map<number, number> }) {
  const userName = (id: any) => lookups.users.find((u: any) => Number(u.id) === Number(id))?.name || null;
  return {
    id: Number(a.id),
    onb_code: a.onb_code,
    user_id: Number(a.user_id),
    candidate_id: a.candidate_id != null ? Number(a.candidate_id) : null,
    name: a.name,
    designation: a.designation,
    department_id: a.department_id != null ? Number(a.department_id) : null,
    department: lookups.departments.find((d: any) => Number(d.id) === Number(a.department_id))?.name || null,
    branch_id: a.branch_id != null ? Number(a.branch_id) : null,
    branch: lookups.branches.find((b: any) => Number(b.id) === Number(a.branch_id))?.branch_name || null,
    joining_date: toDate(a.joining_date),
    email: a.email,
    phone: a.phone,
    status: a.status,
    submitted_at: a.submitted_at,
    review_remarks: a.review_remarks,
    reviewed_by_name: userName(a.reviewed_by),
    reviewed_at: a.reviewed_at,
    employee_id: a.employee_id != null ? Number(a.employee_id) : null,
    created_by: a.created_by != null ? Number(a.created_by) : null,
    created_by_name: userName(a.created_by),
    expires_at: a.expires_at,
    // Seconds until the login closes, by the database clock (null = no expiry running).
    expires_in_seconds: a.expires_in_seconds != null ? Number(a.expires_in_seconds) : null,
    created_at: a.created_at,
    documents: lookups.docCounts?.get(Number(a.id)) ?? 0
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface OnboardingDeps {
  authenticateToken: any;
  requireModule: (k: "hr_operations") => any;
  hasModuleLayer: (user: any, moduleKey: "hr_operations", layer: string) => Promise<boolean>;
  queryDB: QueryDB;
  withTransaction?: Tx;
}

export function registerOnboardingRoutes(app: Express, deps: OnboardingDeps) {
  const { authenticateToken, requireModule, hasModuleLayer, queryDB, withTransaction } = deps;
  const fail = (res: any, err: any, status = 500) => res.status(err?.statusCode || status).json({ error: err?.message || String(err) });
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

  const layersOf = async (user: any) => {
    const out: Record<OnboardingLayer, boolean> = { onboarding_create: false, onboarding_review: false, onboarding_approve: false };
    for (const l of ONBOARDING_LAYERS) out[l] = await hasModuleLayer(user, "hr_operations", l);
    return out;
  };
  // Passes when the account has ANY of the given layers.
  const needLayer =
    (...layers: OnboardingLayer[]) =>
    async (req: any, res: any, next: any) => {
      try {
        for (const l of layers) if (await hasModuleLayer(req.user, "hr_operations", l)) return next();
        res.status(403).json({ error: "You don't have permission to do this. Ask your Superadmin to grant it." });
      } catch (err) {
        fail(res, err);
      }
    };
  const hr = (...layers: OnboardingLayer[]) => [authenticateToken, requireModule("hr_operations"), needLayer(...layers)];

  const companyApp = async (id: number) => {
    const rows: any[] = await queryDB("/*unscoped*/ SELECT * FROM onboarding_applications WHERE id = ? AND company_id = ?", [id, activeCompanyId()]);
    const a = rows.find((r: any) => Number(r.id) === id);
    if (!a) throw bad("Application not found.", 404);
    return a;
  };

  // What this account may do here — the page shows only those controls.
  app.get("/api/hr-ops/joiner-onboarding/access", authenticateToken, requireModule("hr_operations"), async (req: any, res: any) => {
    try {
      res.json(await layersOf(req.user));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/hr-ops/joiner-onboarding", ...hr("onboarding_create", "onboarding_review", "onboarding_approve"), async (_req: any, res: any) => {
    try {
      const [apps, users, departments, branches, docs] = await Promise.all([
        queryDB(
          "/*unscoped*/ SELECT a.*, TIMESTAMPDIFF(SECOND, NOW(), a.expires_at) AS expires_in_seconds FROM onboarding_applications a WHERE a.company_id = ? ORDER BY a.id DESC",
          [activeCompanyId()]
        ),
        queryDB("/*unscoped*/ SELECT id, name FROM users"),
        queryDB("SELECT * FROM departments"),
        queryDB("SELECT * FROM branches"),
        queryDB("/*unscoped*/ SELECT application_id, COUNT(*) AS n FROM onboarding_documents GROUP BY application_id")
      ]);
      const docCounts = new Map<number, number>((docs || []).map((d: any) => [Number(d.application_id), Number(d.n)]));
      res.json((apps || []).map((a: any) => serialize(a, { users, departments, branches, docCounts })));
    } catch (err) {
      fail(res, err);
    }
  });

  // Recruitment candidates marked Hired that have no application yet.
  app.get("/api/hr-ops/joiner-onboarding/hired-candidates", ...hr("onboarding_create"), async (_req: any, res: any) => {
    try {
      const [cands, postings, apps] = await Promise.all([
        queryDB("SELECT * FROM job_candidates WHERE status = 'hired'").catch(() => []),
        queryDB("SELECT * FROM job_postings").catch(() => []),
        queryDB("/*unscoped*/ SELECT candidate_id, status FROM onboarding_applications WHERE candidate_id IS NOT NULL")
      ]);
      const taken = new Set((apps || []).filter((a: any) => OPEN_STATUSES.includes(a.status)).map((a: any) => Number(a.candidate_id)));
      res.json(
        (cands || [])
          .filter((c: any) => c.status === "hired" && !taken.has(Number(c.id)))
          .map((c: any) => {
            const p = (postings || []).find((x: any) => Number(x.id) === Number(c.posting_id));
            return {
              id: Number(c.id),
              name: c.name,
              email: c.email,
              phone: c.phone,
              posting_title: p?.title || null,
              designation: p?.designation || p?.title || null,
              department: p?.department || null
            };
          })
      );
    } catch (err) {
      fail(res, err);
    }
  });

  // Opens an application and its temporary login. The password is returned
  // here only — it is never stored readable and never shown again.
  app.post("/api/hr-ops/joiner-onboarding", ...hr("onboarding_create"), async (req: any, res: any) => {
    try {
      if (!withTransaction) throw bad("Onboarding needs the MySQL database.", 503);
      const b = req.body || {};
      const companyId = activeCompanyId();
      const candidateId = b.candidate_id ? Number(b.candidate_id) : null;
      let name = clean(b.name);
      let email = clean(b.email);
      let phone = clean(b.phone, 60);
      if (candidateId) {
        const rows: any[] = await queryDB("SELECT * FROM job_candidates WHERE id = ?", [candidateId]);
        const c = rows.find((r: any) => Number(r.id) === candidateId);
        if (!c) throw bad("Candidate not found.", 404);
        if (c.status !== "hired") throw bad("Only a candidate marked Hired can be onboarded.");
        name = name || clean(c.name);
        email = email || clean(c.email);
        phone = phone || clean(c.phone, 60);
      }
      if (!name) throw bad("Name is required.");
      const joiningDate = toDate(b.joining_date);
      if (!joiningDate) throw bad("Joining date is required.");
      const designation = clean(b.designation);
      const departmentId = b.department_id ? Number(b.department_id) : null;
      const branchId = b.branch_id ? Number(b.branch_id) : null;
      if (departmentId) {
        const d: any[] = await queryDB("SELECT id FROM departments WHERE id = ?", [departmentId]);
        if (!d.some((x: any) => Number(x.id) === departmentId)) throw bad("Department not found.");
      }
      if (branchId) {
        const br: any[] = await queryDB("SELECT id FROM branches WHERE id = ?", [branchId]);
        if (!br.some((x: any) => Number(x.id) === branchId)) throw bad("Branch not found.");
      }
      const companies: any[] = await queryDB("/*unscoped*/ SELECT id, group_id FROM companies WHERE id = ?", [companyId]);
      const groupId = Number(companies.find((c: any) => Number(c.id) === companyId)?.group_id || 1);
      // Expiry is worked out by the database clock (NOW()), the same clock
      // that later checks it, whatever timezone this process runs in.
      const days = await onboardingExpiryDays(queryDB);
      const password = tempPassword();
      const hash = await bcrypt.hash(password, 10);

      let created: { id: number; code: string; userId: number } | null = null;
      // Two HR people opening applications at the same moment can pick the
      // same ONB number — the unique keys refuse the second, which retries.
      for (let attempt = 0; attempt < 5 && !created; attempt++) {
        try {
          await withTransaction(async (q) => {
            if (candidateId) {
              const open: any[] = await q("SELECT id, status FROM onboarding_applications WHERE candidate_id = ? FOR UPDATE", [candidateId]);
              if (open.some((a: any) => OPEN_STATUSES.includes(a.status))) throw bad("This candidate already has an onboarding application.", 409);
            }
            const code = await nextOnbCode(q);
            const u: any = await q(
              "INSERT INTO users (name, email, username, password_hash, role, group_id, is_onboarding, must_change_password, onboarding_expires_at) VALUES (?, NULL, ?, ?, 'user', ?, 1, 1, DATE_ADD(NOW(), INTERVAL ? DAY))",
              [name, code, hash, groupId, days]
            );
            const userId = Number(u.insertId);
            await q("INSERT INTO user_company_access (user_id, company_id, is_default) VALUES (?, ?, 1)", [userId, companyId]);
            const a: any = await q(
              `INSERT INTO onboarding_applications
                 (company_id, user_id, candidate_id, onb_code, name, designation, department_id, branch_id, joining_date, email, phone, status, data_json, created_by, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', '{}', ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
              [companyId, userId, candidateId, code, name, designation, departmentId, branchId, joiningDate, email, phone, req.user.id, days]
            );
            created = { id: Number(a.insertId), code, userId };
          });
        } catch (err: any) {
          if (err?.code !== "ER_DUP_ENTRY") throw err;
        }
      }
      if (!created) throw bad("Could not pick an Onboarding ID. Try again.", 409);
      const c = created as { id: number; code: string; userId: number };
      res.status(201).json({ id: c.id, onb_code: c.code, login_id: c.code, password, expires_in_days: days });
    } catch (err) {
      fail(res, err);
    }
  });

  // A new temporary password (the old one stops working, and so does every
  // open sign-in). Shown once, like the first.
  app.post("/api/hr-ops/joiner-onboarding/:id/reset-password", ...hr("onboarding_create"), async (req: any, res: any) => {
    try {
      const a = await companyApp(Number(req.params.id));
      if (!["draft", "rejected", "submitted"].includes(a.status)) throw bad("This application is closed.");
      const password = tempPassword();
      await queryDB("/*unscoped*/ UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ? AND is_onboarding = 1", [
        await bcrypt.hash(password, 10),
        Number(a.user_id)
      ]);
      await endAllSessions(queryDB, Number(a.user_id), "password");
      res.json({ login_id: a.onb_code, password });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- the joiner's own side (reachable with the restricted token) ----

  const myApp = async (userId: number) => {
    const rows: any[] = await queryDB("/*unscoped*/ SELECT * FROM onboarding_applications WHERE user_id = ? ORDER BY id DESC", [userId]);
    return rows.find((r: any) => Number(r.user_id) === Number(userId)) || null;
  };

  app.get("/api/onboarding/me", authenticateToken, async (req: any, res: any) => {
    try {
      const a = await myApp(Number(req.user.id));
      if (!a) throw bad("No onboarding application for this account.", 404);
      const [users, departments, branches, me] = await Promise.all([
        queryDB("/*unscoped*/ SELECT id, name FROM users WHERE id = ?", [a.created_by || 0]),
        queryDB("/*unscoped*/ SELECT id, name FROM departments WHERE id = ?", [a.department_id || 0]),
        queryDB("/*unscoped*/ SELECT id, branch_name FROM branches WHERE id = ?", [a.branch_id || 0]),
        queryDB("/*unscoped*/ SELECT must_change_password, TIMESTAMPDIFF(SECOND, NOW(), onboarding_expires_at) AS expires_in_seconds FROM users WHERE id = ?", [req.user.id])
      ]);
      const s = serialize(a, { users, departments, branches });
      res.json({
        id: s.id,
        onb_code: s.onb_code,
        name: s.name,
        designation: s.designation,
        department: s.department,
        branch: s.branch,
        joining_date: s.joining_date,
        email: s.email,
        phone: s.phone,
        status: s.status,
        review_remarks: s.review_remarks,
        submitted_at: s.submitted_at,
        expires_in_seconds: me[0]?.expires_in_seconds != null ? Number(me[0].expires_in_seconds) : null,
        must_change_password: !!Number(me[0]?.must_change_password || 0)
      });
    } catch (err) {
      fail(res, err);
    }
  });
}
