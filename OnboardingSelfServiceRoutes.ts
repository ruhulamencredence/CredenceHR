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
import { requiredDocuments, missingDocuments } from "./HrOps360Routes";
import { createAlert } from "./Alerts";

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

// ---------------------------------------------------------------------------
// What the joiner fills in (data_json)
// ---------------------------------------------------------------------------

// The joiner's own fields — the personal part of all_employees
// (EMPLOYEE_TEXT_FIELDS / EMPLOYEE_DATE_FIELDS in server.ts). Job details
// (designation, department, branch, joining date) are HR's and not here.
export const PERSONAL_TEXT_FIELDS = [
  "gender", "nid_ssn", "nationality", "marital_status", "blood_group", "religion",
  "mobile", "telephone", "personal_email",
  "present_address", "present_city", "present_state", "present_zip", "present_country",
  "permanent_address", "permanent_city", "permanent_state", "permanent_zip", "permanent_country"
] as const;
export const PERSONAL_DATE_FIELDS = ["date_of_birth"] as const;
// Must be filled in before Submit.
export const REQUIRED_FIELDS = ["gender", "date_of_birth", "nid_ssn", "mobile", "present_address", "permanent_address"] as const;
export const FIELD_LABELS: Record<string, string> = {
  gender: "Gender", date_of_birth: "Date of birth", nid_ssn: "NID", nationality: "Nationality", marital_status: "Marital status",
  blood_group: "Blood group", religion: "Religion", mobile: "Mobile", telephone: "Telephone", personal_email: "Personal email",
  present_address: "Present address", present_city: "Present city", present_state: "Present state / division", present_zip: "Present post code",
  present_country: "Present country", permanent_address: "Permanent address", permanent_city: "Permanent city",
  permanent_state: "Permanent state / division", permanent_zip: "Permanent post code", permanent_country: "Permanent country"
};

// Emergency contacts and nominees — the shape hr_emp_family keeps them in.
export interface PersonEntry {
  name: string;
  relation: string | null;
  phone: string | null;
  nid: string | null;
  date_of_birth: string | null;
  address: string | null;
  nominee_percent: number | null;
}
export interface OnboardingData {
  personal: Record<string, string | null>;
  contacts: PersonEntry[];
  nominees: PersonEntry[];
}

const cleanPerson = (p: any, nominee: boolean): PersonEntry | null => {
  const name = clean(p?.name, 150);
  if (!name) return null;
  const pct = Number(p?.nominee_percent);
  return {
    name,
    relation: clean(p?.relation, 60),
    phone: clean(p?.phone, 60),
    nid: clean(p?.nid, 60),
    date_of_birth: toDate(p?.date_of_birth),
    address: clean(p?.address, 500),
    nominee_percent: nominee && p?.nominee_percent !== "" && p?.nominee_percent != null && Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct * 100) / 100)) : null
  };
};

// Only known fields are kept, trimmed and length-limited.
export function cleanOnboardingData(body: any): OnboardingData {
  const personal: Record<string, string | null> = {};
  for (const f of PERSONAL_TEXT_FIELDS) personal[f] = clean(body?.personal?.[f], f.endsWith("_address") ? 1000 : f === "gender" || f === "blood_group" ? 20 : 255);
  for (const f of PERSONAL_DATE_FIELDS) personal[f] = toDate(body?.personal?.[f]);
  const list = (v: any, nominee: boolean) =>
    (Array.isArray(v) ? v : [])
      .slice(0, 10)
      .map((p: any) => cleanPerson(p, nominee))
      .filter(Boolean) as PersonEntry[];
  return { personal, contacts: list(body?.contacts, false), nominees: list(body?.nominees, true) };
}

export function parseOnboardingData(json: any): OnboardingData {
  let raw: any = {};
  try {
    raw = typeof json === "string" ? JSON.parse(json || "{}") : json || {};
  } catch {
    raw = {};
  }
  return cleanOnboardingData(raw);
}

// What still stops Submit: empty required fields, no emergency contact / no
// nominee, nominee shares not adding up to 100 %, missing required documents.
export function onboardingMissing(data: OnboardingData, docTypes: string[], required: string[]): string[] {
  const out: string[] = [];
  for (const f of REQUIRED_FIELDS) if (!data.personal[f]) out.push(FIELD_LABELS[f]);
  if (data.personal.personal_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.personal.personal_email)) out.push("A valid personal email");
  if (!data.contacts.some((c) => c.phone)) out.push("An emergency contact with a phone number");
  if (data.nominees.length === 0) out.push("A nominee");
  const shares = data.nominees.map((n) => n.nominee_percent).filter((x): x is number => x !== null);
  if (shares.length > 0 && Math.abs(shares.reduce((a, b) => a + b, 0) - 100) > 0.01) out.push("Nominee shares adding up to 100 %");
  for (const d of missingDocuments(required, docTypes)) out.push(`Document: ${d}`);
  return out;
}

// Records this person would clash with if approved — an Employee or login
// with the same NID, mobile or email. Shown to HR while reviewing; approval
// refuses while any remain.
export async function findOnboardingDuplicates(q: QueryDB, a: any, data: OnboardingData): Promise<{ field: string; value: string; match: string }[]> {
  const digits = (v: any) => String(v || "").replace(/\D/g, "");
  const phoneKey = (v: any) => digits(v).slice(-10);
  const lower = (v: any) => String(v || "").trim().toLowerCase();
  const nid = digits(data.personal.nid_ssn);
  const phones = [data.personal.mobile, a.phone].map(phoneKey).filter((x) => x.length >= 8);
  const emails = [data.personal.personal_email, a.email].map(lower).filter(Boolean);
  const [emps, users]: any[][] = await Promise.all([
    q("/*unscoped*/ SELECT id, name, employee_id, nid_ssn, mobile, phone, email, personal_email FROM all_employees"),
    q("/*unscoped*/ SELECT id, name, email, username FROM users WHERE id <> ?", [Number(a.user_id)])
  ]);
  const out: { field: string; value: string; match: string }[] = [];
  const who = (e: any) => `Employee ${e.name}${e.employee_id ? ` (${e.employee_id})` : ""}`;
  for (const e of emps || []) {
    if (nid && nid.length >= 6 && digits(e.nid_ssn) === nid) out.push({ field: "NID", value: String(data.personal.nid_ssn), match: who(e) });
    for (const p of phones) if ([e.mobile, e.phone].some((x) => phoneKey(x) === p)) out.push({ field: "Mobile", value: p, match: who(e) });
    for (const m of emails) if ([e.email, e.personal_email].some((x) => lower(x) === m)) out.push({ field: "Email", value: m, match: who(e) });
  }
  for (const u of users || []) for (const m of emails) if (lower(u.email) === m) out.push({ field: "Email", value: m, match: `Login ${u.name}` });
  // One line per (field, value, match).
  return out.filter((x, i) => out.findIndex((y) => y.field === x.field && y.value === x.value && y.match === x.match) === i);
}

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
        must_change_password: !!Number(me[0]?.must_change_password || 0),
        ...(await formState(a))
      });
    } catch (err) {
      fail(res, err);
    }
  });

  const EDITABLE = ["draft", "rejected"];
  const docsOf = async (applicationId: number) =>
    ((await queryDB("/*unscoped*/ SELECT id, application_id, doc_type, file_name, file_mime, LENGTH(file_data) AS size, uploaded_at FROM onboarding_documents WHERE application_id = ? ORDER BY id", [
      applicationId
    ])) || []) as any[];
  const requiredDocs = async () => requiredDocuments(await loadSettings(queryDB));
  // The form's data, documents and what's still missing — the joiner's page
  // and HR's review both use it.
  const formState = async (a: any) => {
    const data = parseOnboardingData(a.data_json);
    const docs = await docsOf(Number(a.id));
    const required = await requiredDocs();
    return {
      data,
      documents: docs.map((d: any) => ({ id: Number(d.id), doc_type: d.doc_type, file_name: d.file_name, file_mime: d.file_mime, size: Number(d.size || 0), uploaded_at: d.uploaded_at })),
      required_documents: required,
      required_fields: REQUIRED_FIELDS.map((f) => FIELD_LABELS[f]),
      missing: onboardingMissing(
        data,
        docs.map((d: any) => d.doc_type),
        required
      )
    };
  };
  const myEditableApp = async (userId: number) => {
    const a = await myApp(userId);
    if (!a) throw bad("No onboarding application for this account.", 404);
    if (!EDITABLE.includes(a.status)) throw bad(a.status === "submitted" ? "Your details are with HR now and can't be changed." : "This onboarding is closed.", 409);
    return a;
  };

  // Save as draft (any part may still be empty).
  app.put("/api/onboarding/me", authenticateToken, async (req: any, res: any) => {
    try {
      const a = await myEditableApp(Number(req.user.id));
      const data = cleanOnboardingData(req.body || {});
      await queryDB("/*unscoped*/ UPDATE onboarding_applications SET data_json = ? WHERE id = ?", [JSON.stringify(data), Number(a.id)]);
      res.json({ success: true, ...(await formState({ ...a, data_json: JSON.stringify(data) })) });
    } catch (err) {
      fail(res, err);
    }
  });

  // One file per document type; a new upload replaces the old one.
  app.post("/api/onboarding/me/documents", authenticateToken, async (req: any, res: any) => {
    try {
      const a = await myEditableApp(Number(req.user.id));
      const b = req.body || {};
      const docType = clean(b.doc_type, 100);
      const fileName = clean(b.file_name, 255);
      if (!docType || !fileName || !b.file_base64) throw bad("Choose the document type and a file.");
      const buf = Buffer.from(String(b.file_base64), "base64");
      if (buf.length === 0) throw bad("The file is empty.");
      if (buf.length > 8 * 1024 * 1024) throw bad("File is larger than 8 MB.");
      const mime = clean(b.file_mime, 100) || "application/octet-stream";
      if (!/^(image\/|application\/pdf$)/.test(mime)) throw bad("Upload a PDF or an image (JPG, PNG…).");
      const existing: any[] = await queryDB("/*unscoped*/ SELECT COUNT(*) AS n FROM onboarding_documents WHERE application_id = ?", [Number(a.id)]);
      const same: any[] = await queryDB("/*unscoped*/ SELECT id FROM onboarding_documents WHERE application_id = ? AND doc_type = ?", [Number(a.id), docType]);
      if (!same.length && Number(existing[0]?.n || 0) >= 20) throw bad("At most 20 documents.");
      await queryDB(
        `/*unscoped*/ INSERT INTO onboarding_documents (application_id, doc_type, file_name, file_mime, file_data) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE file_name = VALUES(file_name), file_mime = VALUES(file_mime), file_data = VALUES(file_data), uploaded_at = CURRENT_TIMESTAMP`,
        [Number(a.id), docType, fileName, mime, buf]
      );
      res.json({ success: true, ...(await formState(a)) });
    } catch (err) {
      fail(res, err);
    }
  });

  const sendFile = (res: any, d: any) => {
    const buf: Buffer = Buffer.isBuffer(d.file_data) ? d.file_data : Buffer.from(d.file_data || "");
    res.setHeader("Content-Type", d.file_mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(d.file_name || "document")}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(buf);
  };

  app.get("/api/onboarding/me/documents/:docId", authenticateToken, async (req: any, res: any) => {
    try {
      const a = await myApp(Number(req.user.id));
      if (!a) throw bad("Not found.", 404);
      const rows: any[] = await queryDB("/*unscoped*/ SELECT * FROM onboarding_documents WHERE id = ? AND application_id = ?", [Number(req.params.docId), Number(a.id)]);
      if (!rows[0]) throw bad("Not found.", 404);
      sendFile(res, rows[0]);
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/onboarding/me/documents/:docId", authenticateToken, async (req: any, res: any) => {
    try {
      const a = await myEditableApp(Number(req.user.id));
      await queryDB("/*unscoped*/ DELETE FROM onboarding_documents WHERE id = ? AND application_id = ?", [Number(req.params.docId), Number(a.id)]);
      res.json({ success: true, ...(await formState(a)) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Hands the form to HR. The login's expiry stops while HR reviews.
  app.post("/api/onboarding/me/submit", authenticateToken, async (req: any, res: any) => {
    try {
      const a = await myEditableApp(Number(req.user.id));
      // The form as saved with this request (the page sends it along).
      const data = req.body && (req.body.personal || req.body.contacts || req.body.nominees) ? cleanOnboardingData(req.body) : parseOnboardingData(a.data_json);
      const state = await formState({ ...a, data_json: JSON.stringify(data) });
      if (state.missing.length) return res.status(400).json({ error: `Still missing: ${state.missing.join(", ")}.`, missing: state.missing });
      const r: any = await queryDB(
        "/*unscoped*/ UPDATE onboarding_applications SET data_json = ?, status = 'submitted', submitted_at = NOW(), expires_at = NULL WHERE id = ? AND status IN ('draft', 'rejected')",
        [JSON.stringify(data), Number(a.id)]
      );
      if (!Number(r?.affectedRows)) throw bad("This application changed meanwhile — reload the page.", 409);
      await queryDB("/*unscoped*/ UPDATE users SET onboarding_expires_at = NULL WHERE id = ? AND is_onboarding = 1", [Number(a.user_id)]);
      await notifyReviewers(a, `New joiner submitted: ${a.name}`, `${a.name} (${a.onb_code}) sent their onboarding details. Review them in HR Operations -> Onboarding -> New Joiners.`);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Everyone who may review or approve onboarding in this company (ticked
  // layers), plus the person who opened it and the group's Superadmins.
  const notifyReviewers = async (a: any, title: string, message: string) => {
    try {
      const [layers, supers]: any[][] = await Promise.all([
        queryDB("/*unscoped*/ SELECT DISTINCT user_id FROM admin_module_permission_layers WHERE module_key = 'hr_operations' AND layer_key IN ('onboarding_review', 'onboarding_approve') AND company_id = ?", [
          Number(a.company_id)
        ]),
        queryDB("/*unscoped*/ SELECT u.id FROM users u JOIN companies c ON c.group_id = u.group_id WHERE u.role = 'superadmin' AND c.id = ?", [Number(a.company_id)])
      ]);
      const ids = new Set<number>([...(layers || []).map((r: any) => Number(r.user_id)), ...(supers || []).map((r: any) => Number(r.id))]);
      if (a.created_by) ids.add(Number(a.created_by));
      for (const userId of ids)
        await createAlert(queryDB, { userId, type: "hr_action", title, message, relatedType: "onboarding_application", relatedId: Number(a.id) });
    } catch {
      // An alert never fails the action itself.
    }
  };

  // ---- HR review ----

  app.get("/api/hr-ops/joiner-onboarding/:id", ...hr("onboarding_review", "onboarding_approve"), async (req: any, res: any) => {
    try {
      const a = await companyApp(Number(req.params.id));
      const [users, departments, branches] = await Promise.all([
        queryDB("/*unscoped*/ SELECT id, name FROM users WHERE id IN (?, ?)", [a.created_by || 0, a.reviewed_by || 0]),
        queryDB("SELECT * FROM departments"),
        queryDB("SELECT * FROM branches")
      ]);
      const state = await formState(a);
      res.json({
        ...serialize(a, { users, departments, branches }),
        ...state,
        duplicates: await findOnboardingDuplicates(queryDB, a, state.data)
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/hr-ops/joiner-onboarding/:id/documents/:docId", ...hr("onboarding_review", "onboarding_approve"), async (req: any, res: any) => {
    try {
      const a = await companyApp(Number(req.params.id));
      const rows: any[] = await queryDB("/*unscoped*/ SELECT * FROM onboarding_documents WHERE id = ? AND application_id = ?", [Number(req.params.docId), Number(a.id)]);
      if (!rows[0]) throw bad("Not found.", 404);
      sendFile(res, rows[0]);
    } catch (err) {
      fail(res, err);
    }
  });
}
