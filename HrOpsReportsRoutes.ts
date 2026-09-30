/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Reports (Admin Panel -> HRM -> HR Operations -> Employee Reports)
// — the Employee 360 page's facts for EVERY Employee at once, so HR can ask
// company-wide questions: how many joined from company X, who has 5+ years
// of experience, whose NID is still missing, who has no nominee, attendance /
// leave / claims / salary / loans side by side…
//
//   One row per Employee ("facts"), built by reading each table once and
//   computing the same figures Employee 360 shows (HrOps360Routes.ts shares
//   its attendance, required-document and leave-label helpers). A report is
//   just a config: which columns, which filters, optionally a column to group
//   and count by (a list column such as "Previous companies" counts each
//   element). Ready-made reports on the page are preset configs.
//
//   Salary and loan columns exist only for accounts holding the Payroll
//   module — for everyone else they are neither returned nor filterable.
//
//   Saved reports (hr_saved_reports) are private to whoever saved them. A
//   saved report can carry a schedule (daily / weekly / monthly at an hour,
//   Dhaka time): the scheduler below runs it as its owner, stores the result
//   as a run (hr_report_runs) and sends each chosen recipient an alert; a
//   recipient can open that run's result, but never the report itself.
//
//   Previous-company names are matched loosely ("XYZ Ltd" = "XYZ Limited" =
//   "xyz limited.") via companyKey, shown under their most common spelling;
//   HR can also merge spellings for good (rewrites hr_emp_experience rows),
//   and the forms suggest names already used so new entries match.
//
// Same data-access convention as HROperationsRoutes.ts: reads are
// `SELECT * FROM x` (optionally narrowed by one condition) and re-filtered in
// JS, writes only ever use `WHERE id = ?`.

import type { Express } from "express";
import type { AlertType } from "./Alerts";
import { loadEmployeeWorld, loadSettings, snapshotOf, currentValues, toDate, parseJson, monthsBetween } from "./HROperationsRoutes";
import {
  coveredMonths,
  requiredDocuments,
  missingDocuments,
  leaveLabelFn,
  loadAttendanceData,
  computeAttendanceDays,
  summarizeDays
} from "./HrOps360Routes";
import { companyStore } from "./companyContext";
import { contextForCompany } from "./CompanyRoutes";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface HrReportsRouteDeps {
  authenticateToken: any;
  requireModule: (moduleKey: "hr_operations") => any;
  queryDB: QueryDB;
  getAdminModules: (userId: number) => Promise<string[]>;
  todayInDhaka: () => string;
  createAlert: (
    queryDB: QueryDB,
    params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function ensureHrReportsSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  const tables: [string, string][] = [
    [
      "hr_saved_reports",
      `CREATE TABLE IF NOT EXISTS hr_saved_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_user_id INT NOT NULL,
        name VARCHAR(150) NOT NULL,
        config_json MEDIUMTEXT NOT NULL,
        -- {frequency: daily|weekly|monthly, weekday, day, hour, recipients: [user ids], only_if_rows}
        schedule_json TEXT NULL,
        last_period VARCHAR(20) NULL,
        last_run_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`
    ],
    [
      "hr_report_runs",
      `CREATE TABLE IF NOT EXISTS hr_report_runs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        report_id INT NULL,
        owner_user_id INT NOT NULL,
        report_name VARCHAR(150) NOT NULL,
        period VARCHAR(20) NULL,
        row_count INT NOT NULL DEFAULT 0,
        recipients_json TEXT NULL,
        result_json MEDIUMTEXT NULL,
        run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    ]
  ];
  for (const [name, ddl] of tables) {
    try {
      await dbPool.query(ddl);
    } catch (err: any) {
      console.warn(`⚠️ Could not ensure ${name} table exists: ` + err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Company names
// ---------------------------------------------------------------------------

const COMPANY_SUFFIXES = new Set(["ltd", "limited", "pvt", "private", "plc", "inc", "incorporated", "co", "company", "corp", "corporation", "llc"]);

// "XYZ Builders Ltd." / "xyz builders limited" / "XYZ Builders (Pvt.) Ltd" -> "xyz builders"
export function companyKey(name: any): string {
  const words = String(name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9ঀ-৿]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && COMPANY_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

// key -> the spelling used most often (ties: the longest).
function companyDisplayNames(experience: any[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const x of experience) {
    const k = companyKey(x.company_name);
    if (!k) continue;
    if (!counts.has(k)) counts.set(k, new Map());
    const m = counts.get(k)!;
    const name = String(x.company_name).trim();
    m.set(name, (m.get(name) || 0) + 1);
  }
  const out = new Map<string, string>();
  for (const [k, m] of counts) {
    out.set(k, [...m.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Column catalog
// ---------------------------------------------------------------------------

type ColType = "text" | "number" | "money" | "date" | "list" | "bool";
type Stage = "base" | "records" | "documents" | "attendance" | "leave" | "claims" | "salary" | "loans" | "assets" | "discipline" | "performance";
export interface ColumnDef {
  key: string;
  label: string;
  group: string;
  type: ColType;
  stage: Stage;
  payroll?: boolean;
}

const C = (key: string, label: string, group: string, type: ColType, stage: Stage, payroll = false): ColumnDef => ({ key, label, group, type, stage, payroll });

export const REPORT_COLUMNS: ColumnDef[] = [
  C("name", "Name", "Employee", "text", "base"),
  C("employee_code", "Employee ID", "Employee", "text", "base"),
  C("designation", "Designation", "Employee", "text", "base"),
  C("department", "Department", "Employee", "text", "base"),
  C("branch", "Branch", "Employee", "text", "base"),
  C("project", "Project", "Employee", "text", "base"),
  C("division", "Division", "Employee", "text", "base"),
  C("unit", "Unit", "Employee", "text", "base"),
  C("grade", "Grade", "Employee", "text", "base"),
  C("supervisor", "Supervisor", "Employee", "text", "base"),
  C("job_base", "Job Base", "Employee", "text", "base"),
  C("employment_category", "Employment Category", "Employee", "text", "base"),
  C("job_status", "Job Status", "Employee", "text", "base"),
  C("service_status", "Service Status", "Employee", "text", "base"),
  C("active", "Active", "Employee", "bool", "base"),
  C("has_login", "Has App Login", "Employee", "bool", "base"),
  C("joining_date", "Joining Date", "Service", "date", "base"),
  C("joining_year", "Joining Year", "Service", "text", "base"),
  C("joining_month", "Joining Month (anniversary)", "Service", "text", "base"),
  C("service_years", "Service (years)", "Service", "number", "base"),
  C("probation_end_date", "Probation End", "Service", "date", "base"),
  C("confirmation_date", "Confirmation Date", "Service", "date", "base"),
  C("contract_end_date", "Contract End", "Service", "date", "base"),
  C("gender", "Gender", "Personal", "text", "base"),
  C("date_of_birth", "Date of Birth", "Personal", "date", "base"),
  C("birth_month", "Birthday Month", "Personal", "text", "base"),
  C("age", "Age", "Personal", "number", "base"),
  C("blood_group", "Blood Group", "Personal", "text", "base"),
  C("religion", "Religion", "Personal", "text", "base"),
  C("marital_status", "Marital Status", "Personal", "text", "base"),
  C("nationality", "Nationality", "Personal", "text", "base"),
  C("mobile", "Mobile", "Personal", "text", "base"),
  C("email", "Email", "Personal", "text", "base"),

  C("previous_companies", "Previous Companies", "Experience", "list", "records"),
  C("last_company", "Last Company (before joining)", "Experience", "text", "records"),
  C("previous_designations", "Previous Designations", "Experience", "list", "records"),
  C("prior_experience_years", "Previous Experience (years)", "Experience", "number", "records"),
  C("total_experience_years", "Total Experience (years)", "Experience", "number", "records"),
  C("prior_experience_band", "Previous Experience Band", "Experience", "text", "records"),
  C("total_experience_band", "Total Experience Band", "Experience", "text", "records"),
  C("experience_records", "Experience Records", "Experience", "number", "records"),
  C("experience_unverified", "Experience Not Verified", "Experience", "number", "records"),
  C("experience_no_certificate", "Experience Without Certificate", "Experience", "number", "records"),

  C("highest_level", "Highest Education Level", "Education", "text", "records"),
  C("highest_degree", "Highest Degree", "Education", "text", "records"),
  C("degrees", "All Degrees", "Education", "list", "records"),
  C("education_levels", "Education Levels", "Education", "list", "records"),
  C("institutes", "Institutes", "Education", "list", "records"),
  C("education_records", "Education Records", "Education", "number", "records"),
  C("education_unverified", "Education Not Verified", "Education", "number", "records"),
  C("education_no_certificate", "Education Without Certificate", "Education", "number", "records"),

  C("trainings", "Trainings", "Training", "list", "records"),
  C("training_count", "Trainings Attended", "Training", "number", "records"),
  C("training_hours", "Training Hours", "Training", "number", "records"),
  C("training_cost", "Training Cost", "Training", "money", "records"),
  C("last_training_date", "Last Training", "Training", "date", "records"),

  C("nominee_status", "Nominee Status", "Family", "text", "records"),
  C("nominees", "Nominees", "Family", "list", "records"),
  C("nominee_share_total", "Nominee Share Total (%)", "Family", "number", "records"),
  C("has_emergency_contact", "Has Emergency Contact", "Family", "bool", "records"),
  C("emergency_contact", "Emergency Contact", "Family", "text", "records"),
  C("dependents", "Dependents", "Family", "number", "records"),

  C("documents_status", "Documents Status", "Documents", "text", "documents"),
  C("missing_documents", "Missing Documents", "Documents", "list", "documents"),
  C("missing_documents_count", "Missing Documents (count)", "Documents", "number", "documents"),
  C("document_types", "Documents on File", "Documents", "list", "documents"),
  C("documents_count", "Documents (count)", "Documents", "number", "documents"),
  C("expired_documents", "Expired Documents", "Documents", "list", "documents"),
  C("unsigned_documents", "Awaiting E-signature", "Documents", "number", "documents"),

  C("att_working", "Working Days", "Attendance", "number", "attendance"),
  C("att_present", "Present", "Attendance", "number", "attendance"),
  C("att_absent", "Absent", "Attendance", "number", "attendance"),
  C("att_leave", "On Leave", "Attendance", "number", "attendance"),
  C("att_late", "Late", "Attendance", "number", "attendance"),
  C("att_extreme_late", "Extreme Late", "Attendance", "number", "attendance"),
  C("att_percent", "Attendance %", "Attendance", "number", "attendance"),

  C("leave_taken", "Leave Taken (days)", "Leave", "number", "leave"),
  C("leave_pending", "Leave Pending (days)", "Leave", "number", "leave"),
  C("leave_remaining", "Leave Remaining (days)", "Leave", "number", "leave"),
  C("casual_taken", "Casual Taken", "Leave", "number", "leave"),
  C("casual_balance", "Casual Balance", "Leave", "number", "leave"),
  C("sick_taken", "Sick Taken", "Leave", "number", "leave"),
  C("sick_balance", "Sick Balance", "Leave", "number", "leave"),
  C("lwp_taken", "Without Pay Taken", "Leave", "number", "leave"),
  C("last_leave_date", "Last Leave", "Leave", "date", "leave"),

  C("claims_count", "Claims", "Claims", "number", "claims"),
  C("claims_claimed", "Claimed", "Claims", "money", "claims"),
  C("claims_approved", "Approved", "Claims", "money", "claims"),
  C("claims_pending", "Pending Amount", "Claims", "money", "claims"),
  C("claims_pending_count", "Pending Claims", "Claims", "number", "claims"),
  C("conveyance_billed", "On Conveyance Bills", "Claims", "money", "claims"),
  C("conveyance_paid", "Conveyance Paid", "Claims", "money", "claims"),
  C("movement_km", "Movement (km)", "Claims", "number", "claims"),

  C("gross_salary", "Gross Salary", "Salary", "money", "salary", true),
  C("basic_salary", "Basic Salary", "Salary", "money", "salary", true),
  C("salary_since", "Current Salary Since", "Salary", "date", "salary", true),
  C("last_increment_date", "Last Increment", "Salary", "date", "salary", true),
  C("last_increment_amount", "Last Increment Amount", "Salary", "money", "salary", true),
  C("last_increment_percent", "Last Increment %", "Salary", "number", "salary", true),
  C("salary_revisions", "Salary Revisions", "Salary", "number", "salary", true),
  C("net_paid_year", "Net Paid (year)", "Salary", "money", "salary", true),
  C("bonus_year", "Bonus (year)", "Salary", "money", "salary", true),

  C("loan_outstanding", "Loan Outstanding", "Loans", "money", "loans", true),
  C("active_loans", "Active Loans", "Loans", "number", "loans", true),
  C("loan_installment", "Monthly Installment", "Loans", "money", "loans", true),
  C("installments_left", "Installments Left", "Loans", "number", "loans", true),

  C("assets_held", "Assets Held", "Assets & Records", "number", "assets"),
  C("asset_names", "Assets", "Assets & Records", "list", "assets"),
  C("disciplinary_count", "Disciplinary Actions", "Assets & Records", "number", "discipline"),
  C("last_disciplinary", "Last Disciplinary Action", "Assets & Records", "text", "discipline"),
  C("exit_status", "Exit Status", "Assets & Records", "text", "discipline"),
  C("last_rating", "Last Performance Rating", "Assets & Records", "number", "performance"),
  C("last_review_cycle", "Last Review Cycle", "Assets & Records", "text", "performance")
];
const COLUMN_BY_KEY = new Map(REPORT_COLUMNS.map((c) => [c.key, c]));

// ---------------------------------------------------------------------------
// Facts — one object per Employee, built stage by stage (only the stages the
// report's columns / filters / grouping actually use are loaded).
// ---------------------------------------------------------------------------

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const EDU_RANK: Record<string, number> = { PhD: 8, Masters: 7, Bachelor: 6, Diploma: 5, "HSC / A Level": 4, "SSC / O Level": 3, Professional: 2, Other: 1 };
const DISCIPLINE_LABEL: Record<string, string> = {
  verbal_warning: "Verbal Warning",
  written_warning: "Written Warning",
  show_cause: "Show Cause",
  suspension: "Suspension",
  termination: "Termination"
};
const round1 = (n: number) => Math.round(n * 10) / 10;
const years = (months: number) => round1(months / 12);
const band = (y: number) => (y < 1 ? "Less than 1 yr" : y < 3 ? "1–3 yrs" : y < 5 ? "3–5 yrs" : y < 10 ? "5–10 yrs" : "10+ yrs");
const groupRows = <K>(rows: any[], key: (r: any) => K | null) => {
  const m = new Map<K, any[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === null || k === undefined) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
};

export interface ReportConfig {
  columns: string[];
  filters?: { key: string; op: string; value?: any }[];
  // "all" (default): every filter must match; "any": at least one.
  match?: "all" | "any";
  group_by?: string | null;
  month?: string; // YYYY-MM | "current" | "previous"
  year?: string | number; // YYYY | "current" | "previous"
  include_inactive?: boolean;
}

function resolvePeriod(config: ReportConfig, today: string) {
  const cur = today.slice(0, 7);
  const [y, m] = cur.split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const month = config.month === "previous" ? prev : /^\d{4}-\d{2}$/.test(String(config.month || "")) ? String(config.month) : cur;
  const year = config.year === "previous" ? y - 1 : /^\d{4}$/.test(String(config.year || "")) ? Number(config.year) : y;
  return { month, year };
}

export async function buildFacts(queryDB: QueryDB, today: string, stages: Set<Stage>, month: string, year: number, includeInactive: boolean) {
  const world = await loadEmployeeWorld(queryDB);
  const employees = world.employees.filter((e: any) => includeInactive || Number(e.is_active ?? 1) !== 0);
  const settings = await loadSettings(queryDB);
  const facts = new Map<number, Record<string, any>>();

  // ---- base ----
  for (const e of employees) {
    const snap = snapshotOf(world, Number(e.id))!;
    const cur = currentValues(snap);
    const joining = toDate(e.joining_date) || toDate(e.created_at);
    const dob = toDate(e.date_of_birth);
    const probEnd =
      toDate(snap.service?.probation_end_date) ||
      (joining ? (() => {
        const d = new Date(`${joining}T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() + Number(snap.service?.probation_months ?? settings.default_probation_months ?? 6));
        return d.toISOString().slice(0, 10);
      })() : null);
    facts.set(Number(e.id), {
      employee_id: Number(e.id),
      user_id: e.user_id ? Number(e.user_id) : null,
      name: e.name,
      employee_code: e.employee_id || null,
      designation: e.designation || null,
      department: e.department || null,
      branch: e.branch || null,
      project: snap.project?.name || null,
      division: e.division || null,
      unit: e.unit || null,
      grade: cur.grade,
      supervisor: cur.supervisor,
      job_base: e.job_base || null,
      employment_category: e.employment_category || null,
      job_status: e.job_status || null,
      service_status:
        snap.service?.service_status ||
        (Number(e.is_active ?? 1) === 0 ? "separated" : e.job_base === "Permanent" ? "confirmed" : e.job_base === "Contractual" ? "contract" : "probation"),
      active: Number(e.is_active ?? 1) !== 0,
      has_login: !!e.user_id,
      joining_date: joining,
      joining_year: joining ? joining.slice(0, 4) : null,
      joining_month: joining ? MONTH_NAMES[Number(joining.slice(5, 7)) - 1] : null,
      service_months: joining ? Math.max(0, monthsBetween(joining, today)) : 0,
      service_years: joining ? years(Math.max(0, monthsBetween(joining, today))) : null,
      probation_end_date: probEnd,
      confirmation_date: toDate(snap.service?.confirmation_date),
      contract_end_date: toDate(snap.service?.contract_end_date),
      gender: e.gender || null,
      date_of_birth: dob,
      birth_month: dob ? MONTH_NAMES[Number(dob.slice(5, 7)) - 1] : null,
      age: dob ? Math.floor(monthsBetween(dob, today) / 12) : null,
      blood_group: e.blood_group || null,
      religion: e.religion || null,
      marital_status: e.marital_status || null,
      nationality: e.nationality || null,
      mobile: e.mobile || e.phone || null,
      email: e.email || null,
      _emp: e,
      _snap: snap
    });
  }
  const byUser = new Map<number, Record<string, any>>();
  for (const f of facts.values()) if (f.user_id) byUser.set(f.user_id, f);

  // ---- records: experience / education / family / training ----
  if (stages.has("records")) {
    const [exp, edu, fam, trn] = await Promise.all([
      queryDB("SELECT * FROM hr_emp_experience").catch(() => []),
      queryDB("SELECT * FROM hr_emp_education").catch(() => []),
      queryDB("SELECT * FROM hr_emp_family").catch(() => []),
      queryDB("SELECT * FROM hr_emp_training").catch(() => [])
    ]);
    const display = companyDisplayNames(exp);
    const expBy = groupRows<number>(exp, (r) => Number(r.employee_id));
    const eduBy = groupRows<number>(edu, (r) => Number(r.employee_id));
    const famBy = groupRows<number>(fam, (r) => Number(r.employee_id));
    const trnBy = groupRows<number>(trn, (r) => Number(r.employee_id));
    for (const f of facts.values()) {
      const xs = (expBy.get(f.employee_id) || []).sort((a: any, b: any) => (toDate(b.to_date) || toDate(b.from_date) || "").localeCompare(toDate(a.to_date) || toDate(a.from_date) || ""));
      const companies: string[] = [];
      for (const x of xs) {
        const n = display.get(companyKey(x.company_name)) || String(x.company_name || "").trim();
        if (n && !companies.includes(n)) companies.push(n);
      }
      const prior = coveredMonths(xs.map((x: any) => ({ from: toDate(x.from_date), to: toDate(x.to_date) || toDate(x.from_date) })), today);
      f.previous_companies = companies;
      f.last_company = companies[0] || null;
      f.previous_designations = [...new Set(xs.map((x: any) => x.designation).filter(Boolean))];
      f.prior_experience_years = years(prior);
      f.total_experience_years = years(prior + f.service_months);
      f.prior_experience_band = band(f.prior_experience_years);
      f.total_experience_band = band(f.total_experience_years);
      f.experience_records = xs.length;
      f.experience_unverified = xs.filter((x: any) => !Number(x.verified)).length;
      f.experience_no_certificate = xs.filter((x: any) => !x.file_name).length;

      const es = (eduBy.get(f.employee_id) || []).sort(
        (a: any, b: any) => (EDU_RANK[b.level] || 0) - (EDU_RANK[a.level] || 0) || Number(b.passing_year || 0) - Number(a.passing_year || 0)
      );
      f.highest_level = es[0]?.level || null;
      f.highest_degree = es[0]?.degree || null;
      f.degrees = es.map((x: any) => x.degree).filter(Boolean);
      f.education_levels = [...new Set(es.map((x: any) => x.level).filter(Boolean))];
      f.institutes = [...new Set(es.map((x: any) => x.institute).filter(Boolean))];
      f.education_records = es.length;
      f.education_unverified = es.filter((x: any) => !Number(x.verified)).length;
      f.education_no_certificate = es.filter((x: any) => !x.file_name).length;

      const fs = famBy.get(f.employee_id) || [];
      const noms = fs.filter((x: any) => Number(x.is_nominee));
      const share = noms.reduce((s: number, x: any) => s + Number(x.nominee_percent || 0), 0);
      f.nominees = noms.map((x: any) => `${x.name}${x.nominee_percent != null ? ` (${Number(x.nominee_percent)}%)` : ""}`);
      f.nominee_share_total = noms.length ? round1(share) : null;
      f.nominee_status = !noms.length ? "No nominee" : Math.abs(share - 100) > 0.01 ? `Shares add up to ${round1(share)}%` : "OK";
      const em = fs.find((x: any) => Number(x.is_emergency));
      f.has_emergency_contact = !!em;
      f.emergency_contact = em ? [em.name, em.relation, em.phone].filter(Boolean).join(" · ") : null;
      f.dependents = fs.filter((x: any) => Number(x.is_dependent)).length;

      const ts = (trnBy.get(f.employee_id) || []).sort((a: any, b: any) => (toDate(b.from_date) || "").localeCompare(toDate(a.from_date) || ""));
      f.trainings = ts.map((x: any) => x.title).filter(Boolean);
      f.training_count = ts.length;
      f.training_hours = round1(ts.reduce((s: number, x: any) => s + Number(x.hours || 0), 0));
      f.training_cost = ts.reduce((s: number, x: any) => s + Number(x.cost || 0), 0);
      f.last_training_date = toDate(ts[0]?.from_date);
    }
  }

  // ---- documents ----
  if (stages.has("documents")) {
    const [docs, sigs] = await Promise.all([queryDB("SELECT * FROM employee_documents").catch(() => []), queryDB("SELECT * FROM document_signatures").catch(() => [])]);
    const signed = new Set(sigs.map((s: any) => Number(s.document_id)));
    const byU = groupRows<number>(docs, (r) => Number(r.user_id));
    const required = requiredDocuments(settings);
    for (const f of facts.values()) {
      const ds = f.user_id ? byU.get(f.user_id) || [] : [];
      const types = ds.map((d: any) => String(d.doc_type));
      const missing = missingDocuments(required, types);
      f.document_types = [...new Set(types)];
      f.documents_count = ds.length;
      f.missing_documents = missing;
      f.missing_documents_count = missing.length;
      f.expired_documents = ds.filter((d: any) => toDate(d.expiry_date) && toDate(d.expiry_date)! < today).map((d: any) => d.doc_type);
      f.unsigned_documents = ds.filter((d: any) => Number(d.requires_signature) && !signed.has(Number(d.id))).length;
      f.documents_status = !f.user_id ? "No login" : missing.length ? `Missing ${missing.length}` : f.expired_documents.length ? "Expired" : "Complete";
    }
  }

  // ---- attendance (one month) ----
  if (stages.has("attendance")) {
    const [yy, mm] = month.split("-").map(Number);
    const from = `${month}-01`;
    const to = `${month}-${String(new Date(yy, mm, 0).getDate()).padStart(2, "0")}`;
    const data = await loadAttendanceData(queryDB, from, to);
    const label = await leaveLabelFn(queryDB);
    for (const f of facts.values()) {
      const s = summarizeDays(computeAttendanceDays(data, f._emp, from, to, today, label));
      f.att_working = s.working_days;
      f.att_present = s.present;
      f.att_absent = s.absent;
      f.att_leave = s.leave;
      f.att_late = s.late;
      f.att_extreme_late = s.extreme_late;
      f.att_percent = s.attendance_percent;
    }
  }

  // ---- leave (one year) ----
  if (stages.has("leave")) {
    const [bals, catBals, cats, apps] = await Promise.all([
      queryDB("SELECT * FROM leave_balances").catch(() => []),
      queryDB("SELECT * FROM leave_category_balances").catch(() => []),
      queryDB("SELECT * FROM leave_categories").catch(() => []),
      queryDB("SELECT * FROM leave_applications").catch(() => [])
    ]);
    const balBy = new Map<number, any>(bals.map((b: any) => [Number(b.user_id), b]));
    const catBy = groupRows<number>(catBals, (r) => Number(r.user_id));
    const appBy = groupRows<number>(apps, (r) => Number(r.user_id));
    void cats;
    for (const f of facts.values()) {
      const uid = f.user_id;
      const ya = uid ? (appBy.get(uid) || []).filter((a: any) => (toDate(a.start_date) || "").startsWith(String(year))) : [];
      const sum = (pred: (a: any) => boolean) => round1(ya.filter(pred).reduce((s: number, a: any) => s + Number(a.day_count || 0), 0));
      const b = uid ? balBy.get(uid) : null;
      const custom = uid ? (catBy.get(uid) || []).reduce((s: number, c: any) => s + Number(c.balance || 0), 0) : 0;
      f.leave_taken = sum((a) => a.status === "approved");
      f.leave_pending = sum((a) => a.status === "pending");
      f.casual_taken = sum((a) => a.status === "approved" && a.leave_type === "casual");
      f.sick_taken = sum((a) => a.status === "approved" && a.leave_type === "sick");
      f.lwp_taken = sum((a) => a.status === "approved" && a.leave_type === "without_pay");
      f.casual_balance = b ? Number(b.casual_leave) : uid ? 0 : null;
      f.sick_balance = b ? Number(b.sick_leave) : uid ? 0 : null;
      f.leave_remaining = uid ? round1((b ? Number(b.casual_leave) + Number(b.sick_leave) : 0) + custom) : null;
      f.last_leave_date = uid
        ? toDate(
            (appBy.get(uid) || [])
              .filter((a: any) => a.status === "approved")
              .sort((a: any, c: any) => (toDate(c.start_date) || "").localeCompare(toDate(a.start_date) || ""))[0]?.start_date
          )
        : null;
    }
  }

  // ---- claims (one year) ----
  if (stages.has("claims")) {
    const [claims, bills, items, moves] = await Promise.all([
      queryDB("SELECT * FROM user_claims").catch(() => []),
      queryDB("SELECT * FROM conveyance_bills").catch(() => []),
      queryDB("SELECT * FROM conveyance_bill_items").catch(() => []),
      queryDB("SELECT * FROM claims").catch(() => [])
    ]);
    const inYear = (d: any) => (toDate(d) || "").startsWith(String(year));
    const itemTotal = new Map<number, number>();
    for (const i of items) itemTotal.set(Number(i.bill_id), (itemTotal.get(Number(i.bill_id)) || 0) + Number(i.amount || 0));
    const cBy = groupRows<number>(claims.filter((c: any) => inYear(c.claim_date)), (r) => Number(r.user_id));
    const bBy = groupRows<number>(bills.filter((b: any) => inYear(b.bill_date)), (r) => Number(r.user_id));
    const mBy = groupRows<number>(moves.filter((c: any) => inYear(c.check_in_at || c.created_at)), (r) => Number(r.user_id));
    for (const f of facts.values()) {
      const cs = f.user_id ? cBy.get(f.user_id) || [] : [];
      const bs = f.user_id ? bBy.get(f.user_id) || [] : [];
      const ms = f.user_id ? mBy.get(f.user_id) || [] : [];
      f.claims_count = cs.length;
      f.claims_claimed = cs.reduce((s: number, c: any) => s + Number(c.amount || 0), 0);
      f.claims_approved = cs.filter((c: any) => c.status === "approved").reduce((s: number, c: any) => s + Number(c.approved_amount ?? c.amount ?? 0), 0);
      f.claims_pending = cs.filter((c: any) => c.status === "pending").reduce((s: number, c: any) => s + Number(c.amount || 0), 0);
      f.claims_pending_count = cs.filter((c: any) => c.status === "pending").length;
      f.conveyance_billed = bs.reduce((s: number, b: any) => s + (itemTotal.get(Number(b.id)) || 0), 0);
      f.conveyance_paid = bs.filter((b: any) => Number(b.is_disbursed)).reduce((s: number, b: any) => s + (itemTotal.get(Number(b.id)) || 0), 0);
      f.movement_km = round1(ms.reduce((s: number, c: any) => s + Number(c.distance_km || 0), 0));
    }
  }

  // ---- salary / payslips (Payroll only) ----
  if (stages.has("salary")) {
    const [payrolls, bonuses] = await Promise.all([queryDB("SELECT * FROM payrolls").catch(() => []), queryDB("SELECT * FROM pending_bonuses").catch(() => [])]);
    const salBy = groupRows<number>(world.salaries, (r) => Number(r.employee_id));
    const payBy = groupRows<number>(payrolls.filter((p: any) => String(p.month_year || "").startsWith(String(year))), (r) => Number(r.employee_id));
    const bonBy = groupRows<number>(bonuses.filter((p: any) => String(p.month_year || "").startsWith(String(year))), (r) => Number(r.employee_id));
    for (const f of facts.values()) {
      const ss = (salBy.get(f.employee_id) || [])
        .filter((s: any) => (toDate(s.effective_date) || "") <= today)
        .sort((a: any, b: any) => (toDate(a.effective_date) || "").localeCompare(toDate(b.effective_date) || "") || Number(a.id) - Number(b.id));
      const cur = ss[ss.length - 1];
      let lastInc: any = null;
      for (let i = ss.length - 1; i > 0; i--) {
        if (Number(ss[i].gross_salary) > Number(ss[i - 1].gross_salary)) {
          lastInc = { date: toDate(ss[i].effective_date), amount: Number(ss[i].gross_salary) - Number(ss[i - 1].gross_salary), prev: Number(ss[i - 1].gross_salary) };
          break;
        }
      }
      f.gross_salary = cur ? Number(cur.gross_salary) : null;
      f.basic_salary = cur ? Number(cur.basic_salary) : null;
      f.salary_since = cur ? toDate(cur.effective_date) : null;
      f.last_increment_date = lastInc?.date || null;
      f.last_increment_amount = lastInc ? lastInc.amount : null;
      f.last_increment_percent = lastInc && lastInc.prev ? round1((lastInc.amount / lastInc.prev) * 100) : null;
      f.salary_revisions = Math.max(0, ss.length - 1);
      f.net_paid_year = (payBy.get(f.employee_id) || []).reduce((s: number, p: any) => s + Number(p.net_salary || 0), 0);
      f.bonus_year = (bonBy.get(f.employee_id) || []).reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
    }
  }

  // ---- loans (Payroll only) ----
  if (stages.has("loans")) {
    const adv: any[] = await queryDB("SELECT * FROM employee_advances").catch(() => []);
    const advBy = groupRows<number>(adv, (r) => Number(r.employee_id));
    for (const f of facts.values()) {
      const act = (advBy.get(f.employee_id) || []).filter((a: any) => a.status === "active");
      const remaining = act.map((a: any) => Math.max(0, Number(a.total_amount || 0) - Number(a.paid_amount || 0)));
      f.loan_outstanding = remaining.reduce((s, x) => s + x, 0);
      f.active_loans = act.length;
      f.loan_installment = act.reduce((s: number, a: any) => s + Number(a.monthly_installment || 0), 0);
      f.installments_left = act.reduce((s: number, a: any, i: number) => s + (Number(a.monthly_installment) > 0 ? Math.ceil(remaining[i] / Number(a.monthly_installment)) : 0), 0);
    }
  }

  // ---- assets / discipline / performance ----
  if (stages.has("assets")) {
    const [assigns, assets] = await Promise.all([queryDB("SELECT * FROM asset_assignments").catch(() => []), queryDB("SELECT * FROM assets").catch(() => [])]);
    const aBy = groupRows<number>(assigns.filter((a: any) => !a.returned_date), (r) => Number(r.employee_user_id));
    const assetName = new Map<number, string>(assets.map((a: any) => [Number(a.id), a.name + (a.asset_tag ? ` (${a.asset_tag})` : "")]));
    for (const f of facts.values()) {
      const held = f.user_id ? aBy.get(f.user_id) || [] : [];
      f.assets_held = held.length;
      f.asset_names = held.map((a: any) => assetName.get(Number(a.asset_id)) || "Asset");
    }
  }
  if (stages.has("discipline")) {
    const [acts, exits] = await Promise.all([queryDB("SELECT * FROM disciplinary_actions").catch(() => []), queryDB("SELECT * FROM exit_requests").catch(() => [])]);
    const dBy = groupRows<number>(acts, (r) => Number(r.user_id));
    const xBy = groupRows<number>(exits.filter((x: any) => x.status !== "cancelled"), (r) => Number(r.user_id));
    for (const f of facts.values()) {
      const ds = (f.user_id ? dBy.get(f.user_id) || [] : []).sort((a: any, b: any) => (toDate(b.issued_at) || "").localeCompare(toDate(a.issued_at) || ""));
      f.disciplinary_count = ds.length;
      f.last_disciplinary = ds[0] ? `${DISCIPLINE_LABEL[ds[0].action_type] || ds[0].action_type} (${toDate(ds[0].issued_at)})` : null;
      const x = (f.user_id ? xBy.get(f.user_id) || [] : []).sort((a: any, b: any) => Number(b.id) - Number(a.id))[0];
      f.exit_status = x ? `${x.exit_type === "termination" ? "Termination" : "Resignation"} — ${x.status}` : null;
    }
  }
  if (stages.has("performance")) {
    const [reviews, cycles] = await Promise.all([queryDB("SELECT * FROM performance_reviews").catch(() => []), queryDB("SELECT * FROM performance_cycles").catch(() => [])]);
    const cyc = new Map<number, any>(cycles.map((c: any) => [Number(c.id), c]));
    const rBy = groupRows<number>(reviews.filter((r: any) => r.overall_rating != null), (r) => Number(r.user_id));
    for (const f of facts.values()) {
      const r = (f.user_id ? rBy.get(f.user_id) || [] : []).sort(
        (a: any, b: any) => (toDate(cyc.get(Number(b.cycle_id))?.period_end) || "").localeCompare(toDate(cyc.get(Number(a.cycle_id))?.period_end) || "")
      )[0];
      f.last_rating = r ? Number(r.overall_rating) : null;
      f.last_review_cycle = r ? cyc.get(Number(r.cycle_id))?.name || null : null;
    }
  }
  return [...facts.values()];
}

// ---------------------------------------------------------------------------
// Filtering and grouping
// ---------------------------------------------------------------------------

const lc = (v: any) => String(v ?? "").toLowerCase();
const isEmpty = (v: any) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

function matches(value: any, type: ColType, op: string, target: any, today: string): boolean {
  if (op === "empty") return isEmpty(value);
  if (op === "not_empty") return !isEmpty(value);
  if (type === "bool") return op === "is_false" ? !value : !!value;
  if (type === "list") {
    const arr: string[] = Array.isArray(value) ? value : [];
    const t = lc(target);
    const tk = companyKey(target);
    const hit = (x: string) => lc(x).includes(t) || (!!tk && companyKey(x) === tk);
    if (op === "contains") return arr.some(hit);
    if (op === "not_contains") return !arr.some(hit);
    if (op === "count_gt") return arr.length > Number(target);
    if (op === "count_lt") return arr.length < Number(target);
    return true;
  }
  if (type === "number" || type === "money") {
    if (isEmpty(value)) return false;
    const v = Number(value);
    if (op === "eq") return v === Number(target);
    if (op === "neq") return v !== Number(target);
    if (op === "gt") return v > Number(target);
    if (op === "gte") return v >= Number(target);
    if (op === "lt") return v < Number(target);
    if (op === "lte") return v <= Number(target);
    if (op === "between") return Array.isArray(target) && v >= Number(target[0]) && v <= Number(target[1]);
    return true;
  }
  if (type === "date") {
    const v = toDate(value);
    if (!v) return false;
    if (op === "before") return v < String(target);
    if (op === "after") return v > String(target);
    if (op === "between") return Array.isArray(target) && v >= String(target[0]) && v <= String(target[1]);
    if (op === "next_days") {
      const end = new Date(`${today}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + Number(target || 0));
      return v >= today && v <= end.toISOString().slice(0, 10);
    }
    if (op === "past_days") {
      const start = new Date(`${today}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() - Number(target || 0));
      return v <= today && v >= start.toISOString().slice(0, 10);
    }
    return true;
  }
  // text
  if (op === "eq") return lc(value) === lc(target);
  if (op === "neq") return lc(value) !== lc(target);
  if (op === "contains") return lc(value).includes(lc(target));
  if (op === "not_contains") return !lc(value).includes(lc(target));
  if (op === "in") return Array.isArray(target) && target.map(lc).includes(lc(value));
  return true;
}

export async function runReport(queryDB: QueryDB, today: string, config: ReportConfig, canPayroll: boolean) {
  const allowed = (k: string) => {
    const c = COLUMN_BY_KEY.get(k);
    return !!c && (!c.payroll || canPayroll);
  };
  const columns = (config.columns || []).filter(allowed);
  if (!columns.includes("name")) columns.unshift("name");
  const filters = (config.filters || []).filter((f) => f && allowed(f.key) && f.op);
  const groupBy = config.group_by && allowed(config.group_by) ? config.group_by : null;
  const stages = new Set<Stage>(["base"]);
  for (const k of [...columns, ...filters.map((f) => f.key), ...(groupBy ? [groupBy] : [])]) stages.add(COLUMN_BY_KEY.get(k)!.stage);
  const { month, year } = resolvePeriod(config, today);
  const facts = await buildFacts(queryDB, today, stages, month, year, !!config.include_inactive);
  const rows = facts
    .filter((f) => {
      if (!filters.length) return true;
      const test = (flt: { key: string; op: string; value?: any }) => matches(f[flt.key], COLUMN_BY_KEY.get(flt.key)!.type, flt.op, flt.value, today);
      return config.match === "any" ? filters.some(test) : filters.every(test);
    })
    .map((f) => {
      const r: Record<string, any> = { employee_id: f.employee_id };
      for (const k of columns) r[k] = f[k] ?? null;
      if (groupBy && !(groupBy in r)) r[groupBy] = f[groupBy] ?? null;
      if (!("employee_code" in r)) r.employee_code = f.employee_code;
      r.user_id = f.user_id;
      return r;
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  let groups: { key: string; count: number; employee_ids: number[] }[] | null = null;
  if (groupBy) {
    const type = COLUMN_BY_KEY.get(groupBy)!.type;
    const m = new Map<string, number[]>();
    for (const r of rows) {
      const v = r[groupBy];
      const keys: string[] =
        type === "list" ? (Array.isArray(v) && v.length ? v.map(String) : ["(none)"]) : type === "bool" ? [v ? "Yes" : "No"] : [isEmpty(v) ? "(blank)" : String(v)];
      for (const k of new Set(keys)) {
        if (!m.has(k)) m.set(k, []);
        m.get(k)!.push(r.employee_id);
      }
    }
    groups = [...m.entries()].map(([key, ids]) => ({ key, count: ids.length, employee_ids: ids })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }
  return {
    columns: columns.map((k) => COLUMN_BY_KEY.get(k)!),
    group_by: groupBy ? COLUMN_BY_KEY.get(groupBy)! : null,
    rows,
    groups,
    total: rows.length,
    month,
    year,
    generated_at: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

interface Schedule {
  frequency: "daily" | "weekly" | "monthly";
  weekday?: number; // 0 = Sunday
  day?: number; // 1-28
  hour?: number; // 0-23, Dhaka time
  recipients?: number[];
  only_if_rows?: boolean;
}

function dhakaNow() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "0";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}

// The most recent scheduled moment on or before now, as a period key — a
// report runs once per key, so a missed moment (server down) runs on the
// next check instead of being skipped.
export function duePeriod(s: Schedule, now: { date: string; hour: number }): string | null {
  const hour = Math.min(23, Math.max(0, Number(s.hour ?? 9)));
  const d = new Date(`${now.date}T00:00:00Z`);
  const back = (days: number) => {
    const x = new Date(d);
    x.setUTCDate(x.getUTCDate() - days);
    return x.toISOString().slice(0, 10);
  };
  if (s.frequency === "daily") return now.hour >= hour ? now.date : back(1);
  if (s.frequency === "weekly") {
    const wd = Math.min(6, Math.max(0, Number(s.weekday ?? 0)));
    let diff = (d.getUTCDay() - wd + 7) % 7;
    if (diff === 0 && now.hour < hour) diff = 7;
    return back(diff);
  }
  if (s.frequency === "monthly") {
    const day = Math.min(28, Math.max(1, Number(s.day ?? 1)));
    const [y, m, dd] = now.date.split("-").map(Number);
    const reached = dd > day || (dd === day && now.hour >= hour);
    const ym = reached ? `${y}-${String(m).padStart(2, "0")}` : m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    return `${ym}-${String(day).padStart(2, "0")}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const MAX_RUN_ROWS = 5000;

export function registerHrReportsRoutes(app: Express, deps: HrReportsRouteDeps) {
  const { authenticateToken, requireModule, queryDB, getAdminModules, todayInDhaka, createAlert } = deps;
  const gate = [authenticateToken, requireModule("hr_operations")];
  const fail = (res: any, err: any, status = 500) => res.status(err?.statusCode || status).json({ error: err?.message || String(err) });
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

  async function modulesOf(userId: number, role?: string): Promise<Set<string>> {
    if (role === undefined) {
      const users: any[] = await queryDB("SELECT * FROM users").catch(() => []);
      role = users.find((u: any) => Number(u.id) === userId)?.role;
    }
    if (role === "superadmin") return new Set(["*"]);
    if (role !== "admin" && role !== "user") return new Set();
    return new Set(await getAdminModules(userId).catch(() => []));
  }
  const has = (mods: Set<string>, k: string) => mods.has("*") || mods.has(k);
  const canPayroll = async (req: any) => has(await modulesOf(Number(req.user.id), req.user.role), "payroll");

  // Anyone who can open HR Operations — the people a schedule may notify.
  async function hrOperatorUsers() {
    const users: any[] = await queryDB("SELECT * FROM users");
    const out: { id: number; name: string }[] = [];
    for (const u of users) {
      if (has(await modulesOf(Number(u.id), u.role), "hr_operations")) out.push({ id: Number(u.id), name: u.name });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  function cleanConfig(c: any): ReportConfig {
    return {
      columns: Array.isArray(c?.columns) ? c.columns.filter((k: any) => COLUMN_BY_KEY.has(String(k))).slice(0, 80) : ["name"],
      filters: Array.isArray(c?.filters)
        ? c.filters
            .filter((f: any) => f && COLUMN_BY_KEY.has(String(f.key)) && typeof f.op === "string")
            .slice(0, 30)
            .map((f: any) => ({ key: String(f.key), op: String(f.op).slice(0, 20), value: f.value ?? null }))
        : [],
      match: c?.match === "any" ? "any" : "all",
      group_by: c?.group_by && COLUMN_BY_KEY.has(String(c.group_by)) ? String(c.group_by) : null,
      month: typeof c?.month === "string" ? c.month.slice(0, 10) : "current",
      year: c?.year != null ? String(c.year).slice(0, 10) : "current",
      include_inactive: !!c?.include_inactive
    };
  }
  function cleanSchedule(s: any): Schedule | null {
    if (!s || !["daily", "weekly", "monthly"].includes(s.frequency)) return null;
    return {
      frequency: s.frequency,
      weekday: Math.min(6, Math.max(0, Number(s.weekday ?? 0))),
      day: Math.min(28, Math.max(1, Number(s.day ?? 1))),
      hour: Math.min(23, Math.max(0, Number(s.hour ?? 9))),
      recipients: Array.isArray(s.recipients) ? [...new Set(s.recipients.map(Number).filter(Boolean))].slice(0, 50) as number[] : [],
      only_if_rows: s.only_if_rows !== false
    };
  }
  const publicSaved = (r: any) => ({
    id: Number(r.id),
    name: r.name,
    config: parseJson(r.config_json, {}),
    schedule: parseJson(r.schedule_json, null),
    last_period: r.last_period || null,
    last_run_at: r.last_run_at || null,
    created_at: r.created_at
  });
  async function ownSaved(req: any, id: number) {
    const rows: any[] = await queryDB("SELECT * FROM hr_saved_reports WHERE id = ?", [id]);
    const r = rows.find((x: any) => Number(x.id) === id);
    if (!r || Number(r.owner_user_id) !== Number(req.user.id)) throw bad("Report not found.", 404);
    return r;
  }

  // Runs a saved report as its owner, stores the result and alerts every
  // recipient. Used by the scheduler and by "Send now".
  async function executeSaved(r: any, period: string | null, force: boolean): Promise<{ run_id: number | null; count: number; notified: number }> {
    const ownerId = Number(r.owner_user_id);
    const mods = await modulesOf(ownerId);
    if (!has(mods, "hr_operations")) return { run_id: null, count: 0, notified: 0 };
    const config = cleanConfig(parseJson(r.config_json, {}));
    const schedule = cleanSchedule(parseJson(r.schedule_json, null));
    const result = await runReport(queryDB, todayInDhaka(), config, has(mods, "payroll"));
    const recipients = [...new Set([...(schedule?.recipients || [])])];
    if (!force && schedule?.only_if_rows && result.total === 0) return { run_id: null, count: 0, notified: 0 };
    const stored = { ...result, rows: result.rows.slice(0, MAX_RUN_ROWS), truncated: result.rows.length > MAX_RUN_ROWS };
    const ins: any = await queryDB(
      "INSERT INTO hr_report_runs (report_id, owner_user_id, report_name, period, row_count, recipients_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [Number(r.id), ownerId, r.name, period, result.total, JSON.stringify(recipients), JSON.stringify(stored)]
    );
    const runId = Number(ins.insertId);
    const top = result.groups?.slice(0, 3).map((g) => `${g.key}: ${g.count}`).join(", ");
    let notified = 0;
    for (const uid of recipients) {
      if (!has(await modulesOf(uid), "hr_operations")) continue;
      await createAlert(queryDB, {
        userId: uid,
        type: "hr_report",
        title: `Report: ${r.name}`,
        message: `${result.total} employee(s)${top ? ` — ${top}` : ""}. Open HR Operations → Employee Reports → Received.`,
        relatedType: "hr_report_run",
        relatedId: runId
      }).catch(() => {});
      notified++;
    }
    return { run_id: runId, count: result.total, notified };
  }

  // ---- scheduler: every 10 minutes, runs whatever is due ----
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const rows: any[] = await queryDB("SELECT * FROM hr_saved_reports").catch(() => []);
      const now = dhakaNow();
      for (const r of rows) {
        const schedule = cleanSchedule(parseJson(r.schedule_json, null));
        if (!schedule) continue;
        const period = duePeriod(schedule, now);
        // First time a schedule is seen, only moments from its creation on count.
        if (!period || period === r.last_period) continue;
        const created = toDate(r.created_at) || now.date;
        if (period < created) continue;
        await queryDB("UPDATE hr_saved_reports SET last_period = ?, last_run_at = ? WHERE id = ?", [period, new Date(), Number(r.id)]);
        // Runs in the company the report was saved in (multi-company).
        const ctx = await contextForCompany(queryDB, Number(r.company_id ?? 1));
        await companyStore
          .run(ctx, () => executeSaved(r, period, false))
          .catch((e) => console.warn(`⚠️ Scheduled report ${r.id} failed: ${e.message}`));
      }
    } catch (err: any) {
      console.warn("⚠️ Report scheduler: " + err.message);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 60 * 1000);
  setInterval(tick, 10 * 60 * 1000);

  // ---- catalog + run ----
  app.get("/api/hr-ops/reports/catalog", ...gate, async (req: any, res: any) => {
    try {
      const pay = await canPayroll(req);
      const mods = await modulesOf(Number(req.user.id), req.user.role);
      res.json({ columns: REPORT_COLUMNS.filter((c) => !c.payroll || pay), payroll: pay, document_vault: has(mods, "document_vault"), recipients: await hrOperatorUsers() });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/hr-ops/reports/run", ...gate, async (req: any, res: any) => {
    try {
      res.json(await runReport(queryDB, todayInDhaka(), cleanConfig(req.body || {}), await canPayroll(req)));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- saved reports (private to their owner) ----
  app.get("/api/hr-ops/saved-reports", ...gate, async (req: any, res: any) => {
    try {
      const rows: any[] = await queryDB("SELECT * FROM hr_saved_reports");
      res.json(rows.filter((r: any) => Number(r.owner_user_id) === Number(req.user.id)).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name))).map(publicSaved));
    } catch (err) {
      fail(res, err);
    }
  });
  app.post("/api/hr-ops/saved-reports", ...gate, async (req: any, res: any) => {
    try {
      const name = String(req.body?.name || "").trim().slice(0, 150);
      if (!name) throw bad("Give the report a name.");
      const schedule = cleanSchedule(req.body?.schedule);
      const now = dhakaNow();
      const r: any = await queryDB("INSERT INTO hr_saved_reports (owner_user_id, name, config_json, schedule_json, last_period) VALUES (?, ?, ?, ?, ?)", [
        req.user.id,
        name,
        JSON.stringify(cleanConfig(req.body?.config)),
        schedule ? JSON.stringify(schedule) : null,
        // The moment already passed when saving doesn't fire immediately.
        schedule ? duePeriod(schedule, now) : null
      ]);
      res.status(201).json({ success: true, id: Number(r.insertId) });
    } catch (err) {
      fail(res, err);
    }
  });
  app.put("/api/hr-ops/saved-reports/:id", ...gate, async (req: any, res: any) => {
    try {
      const r = await ownSaved(req, Number(req.params.id));
      const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 150) : r.name;
      if (!name) throw bad("Give the report a name.");
      const config = req.body?.config !== undefined ? JSON.stringify(cleanConfig(req.body.config)) : r.config_json;
      let scheduleJson = r.schedule_json;
      let lastPeriod = r.last_period;
      if (req.body?.schedule !== undefined) {
        const s = cleanSchedule(req.body.schedule);
        scheduleJson = s ? JSON.stringify(s) : null;
        const oldS = cleanSchedule(parseJson(r.schedule_json, null));
        if (s && JSON.stringify({ ...s, recipients: [] }) !== JSON.stringify(oldS ? { ...oldS, recipients: [] } : null)) lastPeriod = duePeriod(s, dhakaNow());
      }
      await queryDB("UPDATE hr_saved_reports SET name = ?, config_json = ?, schedule_json = ?, last_period = ? WHERE id = ?", [name, config, scheduleJson, lastPeriod, Number(r.id)]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });
  app.delete("/api/hr-ops/saved-reports/:id", ...gate, async (req: any, res: any) => {
    try {
      const r = await ownSaved(req, Number(req.params.id));
      await queryDB("DELETE FROM hr_saved_reports WHERE id = ?", [Number(r.id)]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });
  app.post("/api/hr-ops/saved-reports/:id/send", ...gate, async (req: any, res: any) => {
    try {
      const r = await ownSaved(req, Number(req.params.id));
      if (!cleanSchedule(parseJson(r.schedule_json, null))?.recipients?.length) throw bad("Add at least one recipient to the schedule first.");
      res.json({ success: true, ...(await executeSaved(r, null, true)) });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- runs: the owner's and those sent to me ----
  app.get("/api/hr-ops/report-runs", ...gate, async (req: any, res: any) => {
    try {
      const me = Number(req.user.id);
      const rows: any[] = await queryDB("SELECT * FROM hr_report_runs");
      const users: any[] = await queryDB("SELECT * FROM users").catch(() => []);
      const nameOf = (id: any) => users.find((u: any) => Number(u.id) === Number(id))?.name || null;
      res.json(
        rows
          .filter((r: any) => Number(r.owner_user_id) === me || parseJson(r.recipients_json, []).map(Number).includes(me))
          .sort((a: any, b: any) => Number(b.id) - Number(a.id))
          .slice(0, 200)
          .map((r: any) => ({
            id: Number(r.id),
            report_id: r.report_id ? Number(r.report_id) : null,
            report_name: r.report_name,
            period: r.period,
            row_count: Number(r.row_count || 0),
            run_at: r.run_at,
            sent_by: nameOf(r.owner_user_id),
            mine: Number(r.owner_user_id) === me
          }))
      );
    } catch (err) {
      fail(res, err);
    }
  });
  app.get("/api/hr-ops/report-runs/:id", ...gate, async (req: any, res: any) => {
    try {
      const me = Number(req.user.id);
      const rows: any[] = await queryDB("SELECT * FROM hr_report_runs WHERE id = ?", [Number(req.params.id)]);
      const r = rows.find((x: any) => Number(x.id) === Number(req.params.id));
      if (!r || (Number(r.owner_user_id) !== me && !parseJson(r.recipients_json, []).map(Number).includes(me))) throw bad("Report not found.", 404);
      const result = parseJson(r.result_json, { columns: [], rows: [] });
      // A recipient without Payroll never sees salary / loan columns, even
      // when the owner had them.
      if (!(await canPayroll(req))) {
        const hidden = new Set(REPORT_COLUMNS.filter((c) => c.payroll).map((c) => c.key));
        result.columns = (result.columns || []).filter((c: any) => !hidden.has(c.key));
        result.rows = (result.rows || []).map((row: any) => Object.fromEntries(Object.entries(row).filter(([k]) => !hidden.has(k))));
        if (result.group_by && hidden.has(result.group_by.key)) {
          result.group_by = null;
          result.groups = null;
        }
      }
      res.json({ id: Number(r.id), report_name: r.report_name, period: r.period, run_at: r.run_at, ...result });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- previous-company names ----
  app.get("/api/hr-ops/companies", ...gate, async (_req: any, res: any) => {
    try {
      const [exp, emps] = await Promise.all([queryDB("SELECT * FROM hr_emp_experience").catch(() => []), queryDB("SELECT * FROM all_employees")]);
      const display = companyDisplayNames(exp);
      const byKey = new Map<string, { key: string; name: string; variants: Map<string, number>; employees: Set<number> }>();
      for (const x of exp) {
        const k = companyKey(x.company_name);
        if (!k) continue;
        if (!byKey.has(k)) byKey.set(k, { key: k, name: display.get(k)!, variants: new Map(), employees: new Set() });
        const g = byKey.get(k)!;
        const n = String(x.company_name).trim();
        g.variants.set(n, (g.variants.get(n) || 0) + 1);
        g.employees.add(Number(x.employee_id));
      }
      const empName = new Map<number, string>(emps.map((e: any) => [Number(e.id), e.name]));
      res.json(
        [...byKey.values()]
          .map((g) => ({
            key: g.key,
            name: g.name,
            variants: [...g.variants.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
            employee_count: g.employees.size,
            employees: [...g.employees].map((id) => empName.get(id) || `#${id}`).sort()
          }))
          .sort((a, b) => b.employee_count - a.employee_count || a.name.localeCompare(b.name))
      );
    } catch (err) {
      fail(res, err);
    }
  });

  // Rewrites every experience row whose company matches one of `names` (by
  // companyKey) to `to` — merges spellings, or renames one company.
  app.post("/api/hr-ops/companies/merge", ...gate, async (req: any, res: any) => {
    try {
      const to = String(req.body?.to || "").trim().slice(0, 200);
      const keys = new Set((Array.isArray(req.body?.names) ? req.body.names : []).map(companyKey).filter(Boolean));
      if (!to || keys.size === 0) throw bad("Pick the names to merge and the name to keep.");
      const exp: any[] = await queryDB("SELECT * FROM hr_emp_experience");
      let updated = 0;
      for (const x of exp) {
        if (!keys.has(companyKey(x.company_name)) || String(x.company_name) === to) continue;
        await queryDB("UPDATE hr_emp_experience SET company_name = ? WHERE id = ?", [to, Number(x.id)]);
        updated++;
      }
      res.json({ success: true, updated });
    } catch (err) {
      fail(res, err);
    }
  });

  // Suggestions for the Experience / Education forms (HR Operations and the
  // Employees form, so either module may read them).
  app.get(
    "/api/hr-ops/name-suggestions",
    authenticateToken,
    async (req: any, res: any, next: any) => {
      const mods = await modulesOf(Number(req.user.id), req.user.role);
      if (has(mods, "hr_operations") || has(mods, "employees")) return next();
      res.status(403).json({ error: "You don't have access to this section." });
    },
    async (_req: any, res: any) => {
      try {
        const [exp, edu] = await Promise.all([queryDB("SELECT * FROM hr_emp_experience").catch(() => []), queryDB("SELECT * FROM hr_emp_education").catch(() => [])]);
        const uniq = (vals: any[]) => {
          const seen = new Map<string, string>();
          for (const v of vals) {
            const s = String(v || "").trim();
            if (s && !seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
          }
          return [...seen.values()].sort((a, b) => a.localeCompare(b)).slice(0, 1000);
        };
        res.json({
          companies: [...companyDisplayNames(exp).values()].sort((a, b) => a.localeCompare(b)),
          designations: uniq(exp.map((x: any) => x.designation)),
          institutes: uniq(edu.map((x: any) => x.institute)),
          degrees: uniq(edu.map((x: any) => x.degree)),
          boards: uniq(edu.map((x: any) => x.board_university))
        });
      } catch (err) {
        fail(res, err);
      }
    }
  );
}
