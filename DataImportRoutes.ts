/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Data Import: bring existing records in from an Excel/CSV
// sheet instead of typing them one by one.
//
//   employees          all_employees (matched on Employee ID: new ones are
//                      added, existing ones updated — only the cells filled
//                      in the sheet change)
//   leave              leave_applications (history; no balance is touched)
//   movement_claims    claims (Movement Claim check in / check out)
//   bill_claims        user_claims (Conveyance Bill Claim)
//   remote_attendance  attendance (Remote Attendance check in / check out)
//   office_attendance  zk_attendance_logs (office In/Out punches, kept on an
//                      inactive "Imported attendance" device so the ZKTeco
//                      sync never touches them)
//
// Every kind is one POST with the sheet's rows (already matched to field
// keys by the page): dry_run=true only checks and says what each row would
// do; dry_run=false writes. Rows are always checked the same way, so what
// the check showed is what the import does. Rows already in the system are
// skipped, so importing the same sheet twice adds nothing.
//
// Leave, claims and check in/out belong to a login (users.id); the Employee
// ID resolves to it through all_employees.user_id. Times are Bangladesh wall
// clock ('YYYY-MM-DD HH:MM:SS'), the same way an approved Timesheet
// correction writes them. Historical rows don't open approval requests.

import type { Express } from "express";
import bcrypt from "bcryptjs";
import { applyAccessTemplate, ensureDefaultAccessTemplate } from "./AccessTemplateDefaults";
import { recordEmployeeEditHistory } from "./EmployeeTransferRoutes";
import { activeCompanyId, activeGroupId } from "./companyContext";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface DataImportDeps {
  authenticateToken: any;
  requireAdmin: any;
  queryDB: QueryDB;
  getAdminModules: (userId: number) => Promise<string[]>;
  today: () => string;
  // Same balance change a Leave Application makes when it's submitted.
  adjustLeaveTypeBalance: (userId: number, leaveType: string, delta: number) => Promise<void>;
}

type FieldType = "text" | "date" | "time" | "number" | "yesno";
interface Field {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  aliases?: string[];
  example?: string | number;
  note?: string;
}
interface Kind {
  key: string;
  title: string;
  description: string;
  module: string;
  fields: Field[];
}

const EMP: Field = { key: "employee_id", label: "Employee ID", type: "text", required: true, aliases: ["emp id", "employee code", "code", "id no"], example: "CHL-1024" };

export const IMPORT_KINDS: Kind[] = [
  {
    key: "employees",
    title: "Employee Details",
    description:
      "Adds new employees and updates existing ones, matched on Employee ID. Empty cells leave what's already saved. Fill Login ID and Password to create the employee's login in the same upload.",
    module: "employees",
    fields: [
      EMP,
      { key: "name", label: "Name", type: "text", required: true, aliases: ["employee name", "full name"], example: "Rahim Uddin" },
      { key: "designation", label: "Designation", type: "text", example: "Site Engineer" },
      { key: "department", label: "Department", type: "text", aliases: ["dept"], example: "Engineering", note: "Matched to Admin Panel -> Departments by name" },
      { key: "branch", label: "Branch", type: "text", example: "Head Office", note: "Matched to Admin Panel -> Branches by name" },
      { key: "email", label: "Email", type: "text", aliases: ["office email", "work email"], example: "rahim@company.com" },
      { key: "phone", label: "Phone", type: "text", aliases: ["phone no"], example: "01711000000" },
      { key: "mobile", label: "Mobile", type: "text", aliases: ["mobile no"] },
      { key: "personal_email", label: "Personal Email", type: "text" },
      { key: "joining_date", label: "Joining Date", type: "date", aliases: ["date of joining", "doj"], example: "2024-01-15" },
      { key: "gender", label: "Gender", type: "text", example: "Male" },
      { key: "date_of_birth", label: "Date of Birth", type: "date", aliases: ["dob", "birth date"], example: "1990-05-20" },
      { key: "blood_group", label: "Blood Group", type: "text", example: "B+" },
      { key: "nid_ssn", label: "NID", type: "text", aliases: ["nid no", "national id"] },
      { key: "nationality", label: "Nationality", type: "text" },
      { key: "religion", label: "Religion", type: "text" },
      { key: "marital_status", label: "Marital Status", type: "text" },
      { key: "job_status", label: "Job Status", type: "text", example: "Permanent" },
      { key: "employment_category", label: "Employment Category", type: "text" },
      { key: "job_base", label: "Job Base", type: "text" },
      { key: "division", label: "Division", type: "text" },
      { key: "unit", label: "Unit", type: "text" },
      { key: "present_address", label: "Present Address", type: "text" },
      { key: "permanent_address", label: "Permanent Address", type: "text" },
      { key: "zk_device_pin", label: "Device PIN", type: "text", aliases: ["attendance pin", "zk pin", "machine id"], note: "Office attendance device PIN" },
      { key: "is_active", label: "Active", type: "yesno", example: "Yes", note: "Yes / No" },
      {
        key: "login_id",
        label: "Login ID",
        type: "text",
        aliases: ["user name", "username", "user id", "login", "login email"],
        example: "rahim",
        note: "Email or username they sign in with. With a Password, creates their login (role User) with the default Access Template; skipped if they already have one"
      },
      { key: "login_password", label: "Password", type: "text", aliases: ["pass", "login password"], example: "Rahim@2026", note: "At least 6 characters" }
    ]
  },
  {
    key: "leave",
    title: "Leave History",
    description: "Past leave per employee. Approved / Pending leave in the current leave year is taken off the balance; older leave isn't. HR's Leave Summary Report sheet (one block per employee) can be uploaded as it is.",
    module: "leave_applications",
    fields: [
      EMP,
      { key: "leave_type", label: "Leave Type", type: "text", required: true, aliases: ["type"], example: "Casual", note: "Casual / Sick / Without Pay, or a Leave Category name" },
      { key: "from_date", label: "From Date", type: "date", required: true, aliases: ["start date", "from"], example: "2026-08-10" },
      { key: "to_date", label: "To Date", type: "date", required: true, aliases: ["end date", "to"], example: "2026-08-11" },
      { key: "days", label: "Days", type: "number", aliases: ["day count", "total days"], example: 2, note: "Left empty: counted from the dates" },
      { key: "half_day", label: "Half Day", type: "yesno", note: "Yes / No" },
      { key: "status", label: "Status", type: "text", example: "Approved", note: "Approved / Pending / Rejected (default Approved)" },
      { key: "apply_date", label: "Apply Date", type: "date", aliases: ["applied on"] },
      { key: "purpose", label: "Purpose", type: "text", aliases: ["reason", "remarks"], example: "Family program" }
    ]
  },
  {
    key: "movement_claims",
    title: "Movement Claim History",
    description: "Past Movement Claims (check in / check out for official movement).",
    module: "claims",
    fields: [
      EMP,
      { key: "date", label: "Date", type: "date", required: true, example: "2026-08-12" },
      { key: "check_in", label: "Check In", type: "time", required: true, aliases: ["in time", "start time"], example: "10:15" },
      { key: "check_out", label: "Check Out", type: "time", aliases: ["out time", "end time"], example: "13:40" },
      { key: "purpose", label: "Purpose", type: "text", required: true, example: "Site visit - Mirpur" },
      { key: "distance_km", label: "Distance (km)", type: "number", aliases: ["distance", "km"], example: 12.5 },
      { key: "remarks", label: "Remarks", type: "text" }
    ]
  },
  {
    key: "bill_claims",
    title: "Conveyance Bill Claim History",
    description: "Past Conveyance Bill Claims with their amounts and status.",
    module: "conveyance",
    fields: [
      EMP,
      { key: "claim_date", label: "Claim Date", type: "date", required: true, aliases: ["date"], example: "2026-08-31" },
      { key: "from_date", label: "Bills From", type: "date", aliases: ["from date", "period from"], example: "2026-08-01" },
      { key: "to_date", label: "Bills To", type: "date", aliases: ["to date", "period to"], example: "2026-08-31" },
      { key: "category", label: "Category", type: "text", example: "Transport" },
      { key: "amount", label: "Amount", type: "number", required: true, aliases: ["claim amount"], example: 1850 },
      { key: "approved_amount", label: "Approved Amount", type: "number", example: 1800 },
      { key: "description", label: "Description", type: "text", aliases: ["details", "remarks"] },
      { key: "status", label: "Status", type: "text", example: "Approved", note: "Approved / Pending / Rejected (default Approved)" }
    ]
  },
  {
    key: "remote_attendance",
    title: "Check In / Check Out",
    description: "Remote Attendance (project site) check in and check out times.",
    module: "attendance",
    fields: [
      EMP,
      { key: "date", label: "Date", type: "date", required: true, example: "2026-09-01" },
      { key: "check_in", label: "Check In", type: "time", required: true, aliases: ["in time", "in"], example: "09:05" },
      { key: "check_out", label: "Check Out", type: "time", aliases: ["out time", "out"], example: "18:10" },
      { key: "project", label: "Project", type: "text", aliases: ["project name", "site"], example: "Credence Tower", note: "Left empty: the employee's assigned Attendance Project" },
      { key: "remarks", label: "Remarks", type: "text" }
    ]
  },
  {
    key: "office_attendance",
    title: "Attendance (Office In / Out)",
    description: "Daily office In and Out times, counted like device punches in every attendance report and payroll.",
    module: "office_attendance",
    fields: [
      EMP,
      { key: "date", label: "Date", type: "date", required: true, example: "2026-09-01" },
      { key: "in_time", label: "In Time", type: "time", aliases: ["check in", "in"], example: "09:02" },
      { key: "out_time", label: "Out Time", type: "time", aliases: ["check out", "out"], example: "18:05" }
    ]
  }
];

const MAX_ROWS = 5000;
const IMPORT_DEVICE_NAME = "Imported attendance (Excel)";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const str = (v: any) => (v === undefined || v === null ? "" : String(v).trim());
const pad = (n: number) => String(n).padStart(2, "0");
const validDate = (y: number, m: number, d: number) => {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
};

// 2026-09-01, 2026/9/1, 01/09/2026, 1-9-2026 (day first, as written in
// Bangladesh), 1-Sep-2026, 1 Sep 2026, Sep 1, 2026 — with or without a time after.
export function parseDate(v: any): string | null {
  const s = str(v).replace(/,/g, " ").replace(/\s+/g, " ");
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return validDate(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})/);
  if (m && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) return validDate(+m[3], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1]);
  m = s.match(/^([A-Za-z]{3,})\s(\d{1,2})\s(\d{4})/);
  if (m && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) return validDate(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2]);
  return null;
}

// 9:05, 09:05:30, 9.05, 6:10 PM, 1810 — or the time part of a date-time.
export function parseTime(v: any): string | null {
  let s = str(v).toUpperCase();
  if (!s) return null;
  const dt = s.match(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}[ T](.+)$/) || s.match(/\d{1,2}[-/.]\d{1,2}[-/.]\d{4}[ T](.+)$/);
  if (dt) s = dt[1].trim();
  let m = s.match(/^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*(AM|PM)?$/);
  if (!m) {
    const compact = s.match(/^(\d{3,4})\s*(AM|PM)?$/);
    if (compact) m = [s, compact[1].slice(0, -2), compact[1].slice(-2), undefined as any, compact[2]] as any;
  }
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  const sec = m[3] ? +m[3] : 0;
  if (m[4] === "PM" && h < 12) h += 12;
  if (m[4] === "AM" && h === 12) h = 0;
  if (h > 23 || min > 59 || sec > 59) return null;
  return `${pad(h)}:${pad(min)}:${pad(sec)}`;
}

const parseNumber = (v: any): number | null => {
  const s = str(v).replace(/[,৳\s]|tk\.?/gi, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};
const parseYesNo = (v: any): boolean | null => {
  const s = str(v).toLowerCase();
  if (!s) return null;
  if (["yes", "y", "true", "1", "active", "হ্যাঁ"].includes(s)) return true;
  if (["no", "n", "false", "0", "inactive", "না"].includes(s)) return false;
  return null;
};
const parseStatus = (v: any): "approved" | "pending" | "rejected" | null => {
  const s = str(v).toLowerCase();
  if (!s || s.startsWith("approv") || s === "paid" || s === "done") return "approved";
  if (s.startsWith("pend")) return "pending";
  if (s.startsWith("reject") || s === "declined") return "rejected";
  return null;
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000) + 1;

interface RowResult {
  row: number;
  status: "create" | "update" | "skip" | "error";
  message: string;
  employee?: string;
}

// leave_applications.remarks on imported leave: whether the import has
// already taken it off the balance.
const IMPORTED = "Imported from Excel";
const IMPORTED_DEDUCTED = "Imported from Excel (balance deducted)";

export function registerDataImportRoutes(app: Express, deps: DataImportDeps) {
  const { authenticateToken, requireAdmin, queryDB, getAdminModules, today, adjustLeaveTypeBalance } = deps;

  const allowedKinds = async (user: any) => {
    if (user?.role === "superadmin") return IMPORT_KINDS;
    const mods = await getAdminModules(Number(user.id)).catch(() => [] as string[]);
    return IMPORT_KINDS.filter((k) => mods.includes(k.module));
  };

  app.get("/api/data-import/kinds", authenticateToken, requireAdmin, async (req: any, res) => {
    try {
      res.json({ max_rows: MAX_ROWS, kinds: await allowedKinds(req.user) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post("/api/data-import/:kind", authenticateToken, requireAdmin, async (req: any, res) => {
    try {
      const kind = (await allowedKinds(req.user)).find((k) => k.key === req.params.kind);
      if (!kind) return res.status(403).json({ error: "You don't have access to this import." });
      const rows: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (rows.length === 0) return res.status(400).json({ error: "The sheet has no rows." });
      if (rows.length > MAX_ROWS) return res.status(400).json({ error: `At most ${MAX_ROWS} rows at a time — split the sheet.` });
      const dryRun = req.body?.dry_run !== false;
      const results = await runImport(kind, rows, dryRun, req.user);
      const count = (s: string) => results.filter((r) => r.status === s).length;
      res.json({
        dry_run: dryRun,
        summary: { total: results.length, create: count("create"), update: count("update"), skip: count("skip"), error: count("error") },
        results
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // ---------------------------------------------------------------------

  async function runImport(kind: Kind, rawRows: any[], dryRun: boolean, user: any): Promise<RowResult[]> {
    // Employees of the company being worked in, by Employee ID.
    const employees: any[] = (await queryDB("SELECT * FROM all_employees")) || [];
    const byCode = new Map<string, any>();
    for (const e of employees) if (str(e.employee_id)) byCode.set(str(e.employee_id).toLowerCase(), e);

    const rows = rawRows.map((r, i) => ({ n: Number(r?.__row) || i + 2, v: r || {} }));
    const out: RowResult[] = [];
    const ctx = { dryRun, user, byCode, employees };
    const handler = HANDLERS[kind.key];
    const prepared = handler.prepare ? await handler.prepare(ctx) : {};
    for (const { n, v } of rows) {
      const missing = kind.fields.filter((f) => f.required && !str(v[f.key])).map((f) => f.label);
      if (missing.length) {
        out.push({ row: n, status: "error", message: `Missing ${missing.join(", ")}.`, employee: str(v.employee_id) || undefined });
        continue;
      }
      try {
        out.push({ row: n, ...(await handler.row(v, ctx, prepared)) });
      } catch (err: any) {
        out.push({ row: n, status: "error", message: err?.message || String(err), employee: str(v.employee_id) || undefined });
      }
    }
    return out;
  }

  type Ctx = { dryRun: boolean; user: any; byCode: Map<string, any>; employees: any[] };
  type Handler = {
    prepare?: (ctx: Ctx) => Promise<any>;
    row: (v: any, ctx: Ctx, prep: any) => Promise<Omit<RowResult, "row">>;
  };
  const fail = (message: string): never => {
    throw new Error(message);
  };
  const empOf = (v: any, ctx: Ctx) => {
    const e = ctx.byCode.get(str(v.employee_id).toLowerCase());
    if (!e) fail(`No employee with ID ${str(v.employee_id)} in this company — import Employee Details first.`);
    return e;
  };
  const loginOf = (v: any, ctx: Ctx) => {
    const e = empOf(v, ctx);
    if (!e.user_id) fail(`${e.name} has no login account — this record belongs to a login (Admin Panel -> Users).`);
    return { emp: e, userId: Number(e.user_id) };
  };
  const dateOf = (v: any, key: string, label: string, required = true) => {
    if (!str(v[key])) return required ? fail(`${label} is empty.`) : null;
    return parseDate(v[key]) || fail(`${label} "${str(v[key])}" isn't a date — use YYYY-MM-DD or DD/MM/YYYY.`);
  };
  const timeOf = (v: any, key: string, label: string) => {
    if (!str(v[key])) return null;
    return parseTime(v[key]) || fail(`${label} "${str(v[key])}" isn't a time — use HH:MM (e.g. 09:05 or 6:10 PM).`);
  };

  const HANDLERS: Record<string, Handler> = {
    // ---- Employee details ----------------------------------------------
    employees: {
      prepare: async (ctx) => {
        const departments: any[] = (await queryDB("SELECT id, name FROM departments").catch(() => [])) || [];
        const branches: any[] = (await queryDB("SELECT id, branch_name FROM branches").catch(() => [])) || [];
        const pins: any[] = (await queryDB("SELECT id, name, zk_device_pin FROM all_employees WHERE zk_device_pin IS NOT NULL").catch(() => [])) || [];
        // Every existing login — emails and usernames are unique system-wide.
        const logins: any[] = (await queryDB("/*unscoped*/ SELECT email, username FROM users").catch(() => [])) || [];
        const takenLogins = new Set<string>();
        for (const l of logins) {
          if (l.email) takenLogins.add(String(l.email).toLowerCase());
          if (l.username) takenLogins.add(String(l.username).toLowerCase());
        }
        // New logins get the company's default Access Template (Admin Panel ->
        // Users -> Access Templates) — only when the importer may grant
        // access themself (Superadmin, or "Can grant module access"), the
        // same rule the Module Access switches follow.
        let canGrant = ctx.user?.role === "superadmin";
        if (!canGrant && ctx.user?.id) {
          const me: any[] = (await queryDB("SELECT can_grant_module_access FROM users WHERE id = ?", [ctx.user.id]).catch(() => [])) || [];
          canGrant = Number(me[0]?.can_grant_module_access || 0) === 1;
        }
        const defaultTemplate = canGrant ? await ensureDefaultAccessTemplate(queryDB).catch(() => null) : null;
        return {
          defaultTemplate,
          takenLogins,
          dept: new Map(departments.map((d) => [norm(String(d.name)), d])),
          branch: new Map(branches.map((b) => [norm(String(b.branch_name)), b])),
          pinOwner: new Map(pins.map((p) => [String(p.zk_device_pin), p])),
          seenCodes: new Set<string>()
        };
      },
      row: async (v, ctx, prep) => {
        const code = str(v.employee_id);
        if (code.length > 50) fail("Employee ID is longer than 50 characters.");
        const codeKey = code.toLowerCase();
        if (prep.seenCodes.has(codeKey)) fail(`Employee ID ${code} appears twice in the sheet.`);
        prep.seenCodes.add(codeKey);
        const existing = ctx.byCode.get(codeKey);
        const set: Record<string, any> = { name: str(v.name) };
        const notes: string[] = [];
        const textKeys = [
          "designation", "email", "phone", "mobile", "personal_email", "gender", "blood_group", "nid_ssn", "nationality",
          "religion", "marital_status", "job_status", "employment_category", "job_base", "division", "unit", "present_address", "permanent_address"
        ];
        for (const k of textKeys) if (str(v[k])) set[k] = str(v[k]).slice(0, k.endsWith("_address") ? 2000 : 255);
        for (const [k, label] of [["joining_date", "Joining Date"], ["date_of_birth", "Date of Birth"]] as const) {
          const d = dateOf(v, k, label, false);
          if (d) set[k] = d;
        }
        if (str(v.is_active)) {
          const a = parseYesNo(v.is_active);
          if (a === null) fail(`Active "${str(v.is_active)}" — write Yes or No.`);
          set.is_active = a ? 1 : 0;
        }
        if (str(v.department)) {
          const d = prep.dept.get(norm(str(v.department)));
          set.department = d ? d.name : str(v.department);
          set.department_id = d ? Number(d.id) : null;
          if (!d) notes.push(`Department "${str(v.department)}" isn't in Departments — saved as text`);
        }
        if (str(v.branch)) {
          const b = prep.branch.get(norm(str(v.branch)));
          set.branch = b ? b.branch_name : str(v.branch);
          set.branch_id = b ? Number(b.id) : null;
          if (!b) notes.push(`Branch "${str(v.branch)}" isn't in Branches — saved as text`);
        }
        if (str(v.zk_device_pin)) {
          const pin = str(v.zk_device_pin).slice(0, 20);
          const owner = prep.pinOwner.get(pin);
          if (owner && (!existing || Number(owner.id) !== Number(existing.id))) fail(`Device PIN ${pin} already belongs to ${owner.name}.`);
          set.zk_device_pin = pin;
          prep.pinOwner.set(pin, { id: existing ? existing.id : -1, name: set.name });
        }

        // Login ID + Password -> the employee's own login (role User), same as
        // Admin Panel -> Employees -> "Create login". An email signs in as is;
        // anything else is a username, stored the way sign-in reads it (no
        // spaces, lower case).
        let login: { email: string | null; username: string | null; password: string } | null = null;
        const loginId = str(v.login_id);
        const password = str(v.login_password);
        if (loginId || password) {
          if (!loginId) fail("Password given without a Login ID.");
          if (!password) fail("Login ID given without a Password.");
          if (password.length < 6) fail("Password must be at least 6 characters.");
          if (existing?.user_id) {
            notes.push("Already has a login — Login ID / Password ignored");
          } else {
            const isEmail = loginId.includes("@");
            const id = isEmail ? loginId.toLowerCase().slice(0, 255) : loginId.replace(/\s+/g, "").toLowerCase().slice(0, 100);
            if (prep.takenLogins.has(id)) fail(`Login ID "${id}" is already used by another account.`);
            prep.takenLogins.add(id);
            login = { email: isEmail ? id : null, username: isEmail ? null : id, password };
            notes.push(`Login: ${id}${!isEmail && id !== loginId ? ` (written "${loginId}")` : ""}`);
            notes.push(
              prep.defaultTemplate
                ? `Access: "${prep.defaultTemplate.name}" template`
                : "Access: none given (only the Superadmin or an account that can grant module access gives the default template)"
            );
          }
        }
        const createLogin = async (employeeId: number) => {
          if (!login || ctx.dryRun) return;
          const hash = await bcrypt.hash(login.password, 10);
          const u = await queryDB("INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, 'user')", [
            set.name,
            login.email,
            login.username,
            hash
          ]);
          await queryDB("UPDATE all_employees SET user_id = ? WHERE id = ?", [u.insertId, employeeId]);
          if (prep.defaultTemplate) {
            await applyAccessTemplate(queryDB, Number(u.insertId), prep.defaultTemplate, Number(ctx.user.id) || null, activeCompanyId());
          }
        };

        if (existing) {
          const changed = Object.keys(set).filter((k) => str(existing[k]) !== str(set[k]));
          if (changed.length === 0 && !login) return { status: "skip", message: ["Already up to date", ...notes].join(". "), employee: `${set.name} (${code})` };
          if (!ctx.dryRun && changed.length > 0) {
            await recordEmployeeEditHistory(queryDB, {
              employeeId: Number(existing.id),
              before: existing,
              after: { ...existing, ...set },
              trackedFields: changed.filter((k) => !["department", "department_id", "designation"].includes(k)),
              actionBy: Number(ctx.user.id) || null,
              today: today()
            }).catch(() => undefined);
            await queryDB(`UPDATE all_employees SET ${changed.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...changed.map((k) => set[k]), Number(existing.id)]);
          }
          await createLogin(Number(existing.id));
          const what = [changed.length ? `Changes: ${changed.join(", ")}` : null, login ? "New login" : null].filter(Boolean) as string[];
          return { status: "update", message: [...what, ...notes].join(". "), employee: `${set.name} (${code})` };
        }
        if (!ctx.dryRun) {
          const cols = ["employee_id", ...Object.keys(set)];
          if (!("is_active" in set)) cols.push("is_active");
          const vals = cols.map((c) => (c === "employee_id" ? code : c === "is_active" && !("is_active" in set) ? 1 : set[c]));
          const r = await queryDB(`INSERT INTO all_employees (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, vals);
          ctx.byCode.set(codeKey, { id: r.insertId, employee_id: code, ...set });
          await createLogin(Number(r.insertId));
        }
        return { status: "create", message: [login ? "New employee with login" : "New employee", ...notes].join(". "), employee: `${set.name} (${code})` };
      }
    },

    // ---- Leave history -------------------------------------------------
    leave: {
      prepare: async () => {
        const cats: any[] = (await queryDB("SELECT category_key, label FROM leave_categories").catch(() => [])) || [];
        const existing: any[] =
          (await queryDB("SELECT id, user_id, leave_type, start_date, end_date, day_count, status, remarks FROM leave_applications").catch(() => [])) || [];
        // Start of the current leave year (Leave Manage -> Year Settings, default 1 Jan).
        // Leave from that day on comes off this year's balance; older leave doesn't —
        // its year's balance was already replaced at rollover.
        const ys: any[] = (await queryDB("SELECT start_month_day FROM leave_year_settings WHERE id = ?", [activeGroupId()]).catch(() => [])) || [];
        const md = /^(\d{1,2})-(\d{1,2})$/.exec(String(ys[0]?.start_month_day || "01-01").trim());
        const [sm, sd] = md ? [Number(md[1]), Number(md[2])] : [1, 1];
        const t = today();
        const thisYearStart = `${t.slice(0, 4)}-${String(sm).padStart(2, "0")}-${String(sd).padStart(2, "0")}`;
        const yearStart = t >= thisYearStart ? thisYearStart : `${Number(t.slice(0, 4)) - 1}${thisYearStart.slice(4)}`;
        return { cats, existing, yearStart };
      },
      row: async (v, ctx, prep) => {
        const { emp, userId } = loginOf(v, ctx);
        const t = norm(str(v.leave_type));
        let leaveType: string | null =
          ["casual", "casualleave", "cl"].includes(t)
            ? "casual"
            : ["sick", "sickleave", "sl", "medical", "medicalleave"].includes(t)
            ? "sick"
            : ["withoutpay", "lwp", "leavewithoutpay", "unpaid", "unpaidleave"].includes(t)
            ? "without_pay"
            : null;
        if (!leaveType) {
          const c = prep.cats.find((x: any) => norm(String(x.label)) === t || norm(String(x.category_key)) === t || norm(String(x.label)) === t + "leave");
          if (c) leaveType = c.category_key;
        }
        if (!leaveType) fail(`Leave Type "${str(v.leave_type)}" isn't Casual, Sick, Without Pay or a Leave Category.`);
        const from = dateOf(v, "from_date", "From Date") as string;
        const to = dateOf(v, "to_date", "To Date") as string;
        if (to < from) fail("To Date is before From Date.");
        const half = parseYesNo(v.half_day) === true;
        let days = str(v.days) ? parseNumber(v.days) : half ? 0.5 : daysBetween(from, to);
        if (days === null || !Number.isFinite(days) || days <= 0 || days > 366) fail(`Days "${str(v.days)}" isn't a valid number of days.`);
        days = Math.round(Number(days) * 2) / 2;
        const status = parseStatus(v.status) || fail(`Status "${str(v.status)}" — write Approved, Pending or Rejected.`);
        const applyDate = (dateOf(v, "apply_date", "Apply Date", false) as string | null) || from;
        const overlap = prep.existing.find(
          (l: any) => Number(l.user_id) === userId && l.status !== "rejected" && String(l.start_date).slice(0, 10) <= to && String(l.end_date).slice(0, 10) >= from
        );
        const who = `${emp.name} (${str(v.employee_id)})`;
        // Approved / Pending leave in the current leave year comes off the
        // balance, like a Leave Application does when it's submitted.
        const deducts = (st: string, start: string) => st !== "rejected" && start >= prep.yearStart;
        const label = (lt: string) =>
          lt === "casual" ? "Casual" : lt === "sick" ? "Sick" : lt === "without_pay" ? "Without Pay" : prep.cats.find((c: any) => c.category_key === lt)?.label || lt;
        if (overlap && status !== "rejected") {
          // Imported earlier, before imports took leave off the balance: take it off now, once.
          const s0 = String(overlap.start_date).slice(0, 10);
          if (overlap.id && overlap.remarks === IMPORTED && deducts(String(overlap.status), s0)) {
            const d0 = Number(overlap.day_count) || 0;
            if (!ctx.dryRun) {
              await adjustLeaveTypeBalance(userId, String(overlap.leave_type), -d0);
              await queryDB("UPDATE leave_applications SET remarks = ? WHERE id = ?", [IMPORTED_DEDUCTED, overlap.id]);
            }
            overlap.remarks = IMPORTED_DEDUCTED;
            return { status: "update", message: `Already imported — ${d0} day(s) now taken off the ${label(String(overlap.leave_type))} balance.`, employee: who };
          }
          return { status: "skip", message: `Already has leave ${s0} to ${String(overlap.end_date).slice(0, 10)}.`, employee: who };
        }
        const deduct = deducts(status, from);
        if (!ctx.dryRun) {
          if (deduct) await adjustLeaveTypeBalance(userId, leaveType!, -days);
          await queryDB(
            `INSERT INTO leave_applications (user_id, leave_type, start_date, end_date, day_count, is_half_day, purpose, status, apply_date, remarks, decided_by, decided_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, leaveType, from, to, days, half ? 1 : 0, str(v.purpose), status, applyDate, deduct ? IMPORTED_DEDUCTED : IMPORTED, status === "pending" ? null : Number(ctx.user.id), status === "pending" ? null : new Date()]
          );
        }
        prep.existing.push({ user_id: userId, leave_type: leaveType, start_date: from, end_date: to, day_count: days, status, remarks: deduct ? IMPORTED_DEDUCTED : IMPORTED });
        return {
          status: "create",
          message: `${days} day(s) ${status}${deduct ? ` — taken off the ${label(leaveType!)} balance` : from < prep.yearStart ? " — earlier leave year, balance not changed" : ""}`,
          employee: who
        };
      }
    },

    // ---- Movement claims -----------------------------------------------
    movement_claims: {
      prepare: async () => ({ existing: ((await queryDB("SELECT user_id, check_in_at FROM claims").catch(() => [])) || []) as any[] }),
      row: async (v, ctx, prep) => {
        const { emp, userId } = loginOf(v, ctx);
        const date = dateOf(v, "date", "Date") as string;
        const tin = timeOf(v, "check_in", "Check In") || fail("Check In is empty.");
        const tout = timeOf(v, "check_out", "Check Out");
        if (tout && tout < tin) fail("Check Out is before Check In.");
        const dist = str(v.distance_km) ? parseNumber(v.distance_km) : null;
        if (dist !== null && (!Number.isFinite(dist) || dist < 0)) fail(`Distance "${str(v.distance_km)}" isn't a number.`);
        const inAt = `${date} ${tin}`;
        const who = `${emp.name} (${str(v.employee_id)})`;
        if (prep.existing.some((c: any) => Number(c.user_id) === userId && String(c.check_in_at).slice(0, 16) === inAt.slice(0, 16)))
          return { status: "skip", message: `Already has a claim checked in at ${inAt.slice(0, 16)}.`, employee: who };
        if (!ctx.dryRun) {
          await queryDB(
            `INSERT INTO claims (user_id, purpose, status, check_in_at, check_in_remarks, check_out_at, check_out_remarks, distance_km)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, str(v.purpose).slice(0, 255), tout ? "completed" : "open", inAt, str(v.remarks) || "Imported from Excel", tout ? `${date} ${tout}` : null, null, dist]
          );
        }
        prep.existing.push({ user_id: userId, check_in_at: inAt });
        return { status: "create", message: tout ? `${tin.slice(0, 5)} – ${tout.slice(0, 5)}` : `Checked in ${tin.slice(0, 5)} (still open)`, employee: who };
      }
    },

    // ---- Conveyance bill claims ----------------------------------------
    bill_claims: {
      prepare: async () => ({ existing: ((await queryDB("SELECT user_id, claim_date, category, amount FROM user_claims").catch(() => [])) || []) as any[] }),
      row: async (v, ctx, prep) => {
        const { emp, userId } = loginOf(v, ctx);
        const claimDate = dateOf(v, "claim_date", "Claim Date") as string;
        const from = (dateOf(v, "from_date", "Bills From", false) as string | null) || claimDate;
        const to = (dateOf(v, "to_date", "Bills To", false) as string | null) || from;
        if (to < from) fail("Bills To is before Bills From.");
        const amount = parseNumber(v.amount);
        if (amount === null || !Number.isFinite(amount) || amount <= 0) fail(`Amount "${str(v.amount)}" isn't a number above 0.`);
        const approvedRaw = str(v.approved_amount) ? parseNumber(v.approved_amount) : null;
        if (approvedRaw !== null && (!Number.isFinite(approvedRaw) || approvedRaw < 0)) fail(`Approved Amount "${str(v.approved_amount)}" isn't a number.`);
        const status = parseStatus(v.status) || fail(`Status "${str(v.status)}" — write Approved, Pending or Rejected.`);
        const category = str(v.category).slice(0, 255) || "Others";
        const approved = status === "approved" ? (approvedRaw ?? amount) : approvedRaw;
        const who = `${emp.name} (${str(v.employee_id)})`;
        if (
          prep.existing.some(
            (c: any) => Number(c.user_id) === userId && String(c.claim_date).slice(0, 10) === claimDate && String(c.category) === category && Number(c.amount) === Number(amount)
          )
        )
          return { status: "skip", message: `Same claim (${claimDate}, ${category}, ${amount}) is already there.`, employee: who };
        if (!ctx.dryRun) {
          await queryDB(
            `INSERT INTO user_claims (user_id, claim_date, from_date, to_date, category, amount, approved_amount, description, status, admin_remarks, reviewed_by, reviewed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              userId, claimDate, from, to, category, amount, approved, str(v.description) || null, status, "Imported from Excel",
              status === "pending" ? null : Number(ctx.user.id), status === "pending" ? null : new Date()
            ]
          );
        }
        prep.existing.push({ user_id: userId, claim_date: claimDate, category, amount });
        return { status: "create", message: `${category} ${amount} — ${status}`, employee: who };
      }
    },

    // ---- Remote attendance check in / out -------------------------------
    remote_attendance: {
      prepare: async () => {
        const projects: any[] = (await queryDB("SELECT id, project_name FROM projects").catch(() => [])) || [];
        const users: any[] = (await queryDB("SELECT id, attendance_project_id FROM users").catch(() => [])) || [];
        const existing: any[] = (await queryDB("SELECT id, user_id, project_id, attendance_date, check_in_at, check_out_at FROM attendance").catch(() => [])) || [];
        return {
          projects: new Map(projects.map((p) => [norm(String(p.project_name)), p])),
          projectById: new Map(projects.map((p) => [Number(p.id), p])),
          userProject: new Map(users.map((u) => [Number(u.id), u.attendance_project_id ? Number(u.attendance_project_id) : null])),
          existing
        };
      },
      row: async (v, ctx, prep) => {
        const { emp, userId } = loginOf(v, ctx);
        const date = dateOf(v, "date", "Date") as string;
        const tin = timeOf(v, "check_in", "Check In") || fail("Check In is empty.");
        const tout = timeOf(v, "check_out", "Check Out");
        if (tout && tout < tin) fail("Check Out is before Check In.");
        let project: any = null;
        if (str(v.project)) project = prep.projects.get(norm(str(v.project))) || fail(`Project "${str(v.project)}" isn't in Projects.`);
        else {
          const pid = prep.userProject.get(userId);
          project = (pid && prep.projectById.get(pid)) || fail("Project is empty and this employee has no assigned Attendance Project.");
        }
        const who = `${emp.name} (${str(v.employee_id)})`;
        const same = prep.existing.find((a: any) => Number(a.user_id) === userId && Number(a.project_id) === Number(project.id) && String(a.attendance_date).slice(0, 10) === date);
        if (same) {
          // Only fills a missing check out — never replaces recorded times.
          if (!same.check_out_at && tout) {
            if (!ctx.dryRun) await queryDB("UPDATE attendance SET check_out_at = ?, check_out_remarks = ? WHERE id = ?", [`${date} ${tout}`, str(v.remarks) || "Imported from Excel", Number(same.id)]);
            same.check_out_at = `${date} ${tout}`;
            return { status: "update", message: `Adds the missing check out ${tout.slice(0, 5)}.`, employee: who };
          }
          return { status: "skip", message: `Already checked in on ${date} at ${project.project_name}.`, employee: who };
        }
        if (!ctx.dryRun) {
          await queryDB(
            `INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_in_remarks, check_out_at, check_out_remarks)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, Number(project.id), date, `${date} ${tin}`, str(v.remarks) || "Imported from Excel", tout ? `${date} ${tout}` : null, null]
          );
        }
        prep.existing.push({ user_id: userId, project_id: Number(project.id), attendance_date: date, check_in_at: `${date} ${tin}`, check_out_at: tout ? `${date} ${tout}` : null });
        return { status: "create", message: `${project.project_name}: ${tin.slice(0, 5)}${tout ? ` – ${tout.slice(0, 5)}` : ""}`, employee: who };
      }
    },

    // ---- Office attendance (In / Out punches) ---------------------------
    office_attendance: {
      prepare: async (ctx) => {
        const devices: any[] = (await queryDB("SELECT id, name, ip_address FROM zk_devices").catch(() => [])) || [];
        let device = devices.find((d) => d.ip_address === "import" && d.name === IMPORT_DEVICE_NAME);
        const pins: any[] = (await queryDB("SELECT id, zk_device_pin FROM all_employees WHERE zk_device_pin IS NOT NULL").catch(() => [])) || [];
        const punches: any[] = (await queryDB("SELECT device_user_pin, punch_time FROM zk_attendance_logs").catch(() => [])) || [];
        return {
          device,
          takenPins: new Set(pins.map((p) => String(p.zk_device_pin))),
          punchKeys: new Set(punches.map((p) => `${p.device_user_pin}|${String(p.punch_time).slice(0, 16)}`)),
          newPins: new Map<number, string>()
        };
      },
      row: async (v, ctx, prep) => {
        const emp = empOf(v, ctx);
        const date = dateOf(v, "date", "Date") as string;
        const tin = timeOf(v, "in_time", "In Time");
        const tout = timeOf(v, "out_time", "Out Time");
        if (!tin && !tout) fail("Both In Time and Out Time are empty.");
        if (tin && tout && tout < tin) fail("Out Time is before In Time.");
        const who = `${emp.name} (${str(v.employee_id)})`;
        // An employee without a device PIN gets one (E + their record id), so
        // these punches are theirs in every attendance report.
        let pin: string = emp.zk_device_pin ? String(emp.zk_device_pin) : prep.newPins.get(Number(emp.id)) || "";
        let pinNote = "";
        if (!pin) {
          pin = `E${emp.id}`;
          if (prep.takenPins.has(pin)) fail(`Couldn't give ${emp.name} a Device PIN (${pin} is taken) — set one in Employees.`);
          prep.newPins.set(Number(emp.id), pin);
          prep.takenPins.add(pin);
          pinNote = ` Device PIN ${pin} given (had none).`;
          if (!ctx.dryRun) {
            await queryDB("UPDATE all_employees SET zk_device_pin = ? WHERE id = ?", [pin, Number(emp.id)]);
            emp.zk_device_pin = pin;
          }
        }
        const times = [tin, tout].filter(Boolean) as string[];
        const fresh = times.filter((t) => !prep.punchKeys.has(`${pin}|${date} ${t.slice(0, 5)}`));
        if (fresh.length === 0) return { status: "skip", message: `Punches on ${date} are already there.`, employee: who };
        if (!ctx.dryRun) {
          if (!prep.device) {
            // One per company; the port keeps (ip, port) unique across companies.
            const r = await queryDB("INSERT INTO zk_devices (name, ip_address, port, is_active) VALUES (?, 'import', ?, 0)", [IMPORT_DEVICE_NAME, activeCompanyId()]);
            prep.device = { id: r.insertId };
          }
          for (const t of fresh) {
            await queryDB("INSERT IGNORE INTO zk_attendance_logs (device_id, device_user_pin, punch_time) VALUES (?, ?, ?)", [Number(prep.device.id), pin, `${date} ${t}`]);
          }
        }
        for (const t of fresh) prep.punchKeys.add(`${pin}|${date} ${t.slice(0, 5)}`);
        return { status: "create", message: `${[tin, tout].map((t) => (t ? t.slice(0, 5) : "—")).join(" – ")}.${pinNote}`, employee: who };
      }
    }
  };
}
