/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations (Admin Panel -> HRM -> HR Operations) — everything HR does to
// an Employee after the Employee record exists, kept in one place:
//
//   Personnel Actions — Promotion, Increment, Transfer, Confirmation, Grade /
//     Designation change, Salary adjustment, Contract renewal, Probation
//     extension, Suspension, Resignation, Termination, Retirement. Each one
//     records FROM -> TO values, goes through this module's own ordered
//     approval chain (configurable per action type, e.g. HR Head -> MD), and
//     is applied to the Employee on its Effective Date:
//       - Department / Designation / Supervisor changes reuse the existing
//         employee_transfers table + applyDueEmployeeTransfers (so the
//         Employees page's Transfer History keeps showing them),
//       - a salary change inserts a new salary_structures row dated on the
//         Effective Date (Payroll already picks the structure by date),
//       - grade / probation / contract / service status live in
//         hr_employee_service, one row per Employee.
//     Pending steps show up in every approver's own "Approve Application"
//     page through getMyHrActionApprovals (ApprovalRoutes.ts).
//   Service Book — one timeline per Employee built from joining date,
//     transfers, salary revisions, personnel actions, letters, disciplinary
//     actions and exit requests.
//   Letters — HR-editable templates with {{placeholders}}, an automatic
//     reference number, an issue register, and the Employee's own
//     acknowledgement from Self Service. Employees can also request a Salary
//     / Experience certificate or NOC from Self Service.
//   Onboarding — a per-Employee checklist (appointment letter, documents,
//     bank account opening + the bank's acknowledgement, ID card, login…)
//     seeded from HR-editable tasks; a few items tick themselves when the
//     data already exists elsewhere in the app.
//   Increment policies — HR defines as many rules as needed (on each
//     Employee's joining anniversary, or in a fixed month for everyone,
//     optionally limited to a Department / Grade / category); "Increment Due"
//     lists who a rule applies to and turns a reviewed list into Increment
//     actions in one go.
//   Monthly report — headcount, joiners, separations, promotions, transfers,
//     increments, confirmations, grouped by any Employee dimension.
//
// Same data-access convention as ExitOffboardingRoutes.ts/GrievanceRoutes.ts:
// reads are full-table `SELECT * FROM x` filtered in JS (the only shape the
// in-memory fallback DB understands) and writes only ever use `WHERE id = ?`.

import type { Express } from "express";
import type { AlertType } from "./Alerts";
import { applyDueEmployeeTransfers } from "./EmployeeTransferRoutes";
import { applyCompanyTransfer } from "./CompanyRoutes";
import { blockEmployeeLogin } from "./AccountBlock";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface HROperationsRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
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
// Constants
// ---------------------------------------------------------------------------

export const HR_ACTION_TYPES: { key: string; label: string; letter: string | null }[] = [
  { key: "promotion", label: "Promotion", letter: "promotion" },
  { key: "increment", label: "Increment", letter: "increment" },
  { key: "transfer", label: "Transfer", letter: "transfer" },
  // Moves the Employee to a sister company (multi-company) — see applyCompanyTransfer.
  { key: "company_transfer", label: "Company Transfer (sister concern)", letter: "transfer" },
  { key: "confirmation", label: "Confirmation", letter: "confirmation" },
  { key: "designation_change", label: "Designation Change", letter: "general" },
  { key: "grade_change", label: "Grade Change", letter: "general" },
  { key: "salary_adjustment", label: "Salary Adjustment", letter: "increment" },
  { key: "contract_renewal", label: "Contract Renewal", letter: "general" },
  { key: "probation_extension", label: "Probation Extension", letter: "general" },
  { key: "suspension", label: "Suspension", letter: "general" },
  { key: "resignation", label: "Resignation Acceptance", letter: "release" },
  { key: "termination", label: "Termination", letter: "general" },
  { key: "retirement", label: "Retirement", letter: "general" },
  { key: "other", label: "Other", letter: "general" }
];
const ACTION_LABEL = new Map(HR_ACTION_TYPES.map((a) => [a.key, a.label]));
const SEPARATION_TYPES = new Set(["resignation", "termination", "retirement"]);

export const LETTER_TYPES: { key: string; label: string; code: string }[] = [
  { key: "appointment", label: "Appointment Letter", code: "APT" },
  { key: "joining", label: "Joining Letter Acceptance", code: "JON" },
  { key: "confirmation", label: "Confirmation Letter", code: "CNF" },
  { key: "promotion", label: "Promotion Letter", code: "PRM" },
  { key: "transfer", label: "Transfer Order", code: "TRF" },
  { key: "increment", label: "Increment Letter", code: "INC" },
  { key: "bank_account", label: "Bank Account Opening Letter", code: "BNK" },
  { key: "salary_certificate", label: "Salary Certificate", code: "SAL" },
  { key: "experience", label: "Experience Certificate", code: "EXP" },
  { key: "release", label: "Release Letter", code: "REL" },
  { key: "noc", label: "No Objection Certificate (NOC)", code: "NOC" },
  { key: "general", label: "General Letter", code: "GEN" }
];
const LETTER_CODE = new Map(LETTER_TYPES.map((l) => [l.key, l.code]));
const LETTER_LABEL = new Map(LETTER_TYPES.map((l) => [l.key, l.label]));
// Letter types an Employee may request from Self Service.
const SELF_REQUESTABLE = new Set(["salary_certificate", "experience", "noc", "bank_account"]);

const DEFAULT_SETTINGS: Record<string, string> = {
  company_name: "Credence Housing Limited",
  company_code: "CHL",
  company_address: "Dhaka, Bangladesh",
  ref_format: "{CODE}/HR/{TYPE}/{YYYY}/{SEQ}",
  signatory_name: "Head of HR",
  signatory_designation: "Human Resources Department",
  default_probation_months: "6",
  // Employee 360 -> Documents: the document types every Employee should have
  // on file (one per line); anything not uploaded is listed as missing.
  required_documents: "NID\nPhotograph\nCV / Resume\nEducational Certificate\nAppointment Letter (signed)"
};

const DEFAULT_ONBOARDING_TASKS: { task_key: string; label: string; category: string; due_days: number }[] = [
  { task_key: "appointment_letter", label: "Appointment Letter issued", category: "Letters", due_days: -3 },
  { task_key: "appointment_signed", label: "Signed copy of Appointment Letter received", category: "Letters", due_days: 3 },
  { task_key: "joining_report", label: "Joining Report submitted", category: "Letters", due_days: 0 },
  { task_key: "doc_nid", label: "NID copy received", category: "Documents", due_days: 3 },
  { task_key: "doc_photo", label: "Passport size photographs received", category: "Documents", due_days: 3 },
  { task_key: "doc_certificates", label: "Educational certificates verified", category: "Documents", due_days: 7 },
  { task_key: "doc_release", label: "Release letter from previous employer", category: "Documents", due_days: 15 },
  { task_key: "bank_letter", label: "Bank Account Opening Letter issued", category: "Bank Account", due_days: 1 },
  { task_key: "bank_account", label: "Bank account number received", category: "Bank Account", due_days: 10 },
  { task_key: "bank_ack", label: "Bank acknowledgement received & verified", category: "Bank Account", due_days: 15 },
  { task_key: "login_account", label: "App login account created", category: "System & Access", due_days: 0 },
  { task_key: "device_pin", label: "Attendance device PIN set", category: "System & Access", due_days: 0 },
  { task_key: "id_card", label: "ID card issued", category: "System & Access", due_days: 7 },
  { task_key: "supervisor", label: "Supervisor assigned", category: "Work Setup", due_days: 0 },
  { task_key: "asset_handover", label: "Office assets handed over", category: "Work Setup", due_days: 3 },
  { task_key: "orientation", label: "Orientation / induction done", category: "Work Setup", due_days: 7 },
  { task_key: "probation_set", label: "Probation period set", category: "Work Setup", due_days: 0 }
];

// Default letter templates — plain text with {{placeholders}}; blank lines
// separate paragraphs. HR edits/saves their own versions from Settings.
const DEFAULT_TEMPLATES: { letter_type: string; name: string; subject: string; body: string }[] = [
  {
    letter_type: "appointment",
    name: "Appointment Letter (Standard)",
    subject: "Letter of Appointment",
    body: `{{salutation}} {{employee_name}}
{{present_address}}

Dear {{salutation}} {{employee_last_name}},

With reference to your application and the subsequent interview, we are pleased to appoint you as {{designation}} in the {{department}} department of {{company_name}}, on the following terms and conditions:

1. Joining: You are requested to join on or before {{joining_date}}. Your place of work will be {{branch}}, though you may be transferred to any office, project or site of the company as required.

2. Probation: You will be on probation for {{probation_months}} months from the date of joining. On satisfactory completion of the probation period your service will be confirmed in writing.

3. Salary: You will receive a consolidated monthly gross salary of BDT {{gross_salary}} ({{gross_salary_words}}), comprising Basic Salary of BDT {{basic_salary}} and other allowances as per company policy. Income tax, if applicable, will be deducted at source.

4. Working Hours & Leave: Office hours, holidays and leave will be as per the company's rules in force from time to time.

5. Notice Period: During probation either party may terminate the employment with one month's notice. After confirmation, the notice period will be two months or salary in lieu thereof.

6. Confidentiality: You shall not disclose any information relating to the business of the company to any unauthorised person during or after your employment.

Please sign and return the duplicate copy of this letter as a token of your acceptance of the above terms and conditions.

We welcome you to the {{company_name}} family and wish you a successful career with us.`
  },
  {
    letter_type: "joining",
    name: "Joining Acceptance",
    subject: "Acceptance of Joining Report",
    body: `Dear {{salutation}} {{employee_last_name}},

This is to acknowledge that you have joined {{company_name}} as {{designation}} in the {{department}} department on {{joining_date}}, and your joining report has been accepted.

Your Employee ID is {{employee_code}}. Please use this ID in all official communication.

You will remain on probation until {{probation_end_date}}. We look forward to your contribution.`
  },
  {
    letter_type: "confirmation",
    name: "Confirmation of Service",
    subject: "Confirmation of Service",
    body: `Dear {{salutation}} {{employee_last_name}},

We are pleased to inform you that, on successful completion of your probation period, the management has decided to confirm your service as {{designation}} in the {{department}} department with effect from {{effective_date}}.

All other terms and conditions of your employment remain unchanged.

We appreciate your performance so far and look forward to your continued contribution.`
  },
  {
    letter_type: "promotion",
    name: "Promotion Letter",
    subject: "Promotion to {{new_designation}}",
    body: `Dear {{salutation}} {{employee_last_name}},

In recognition of your performance and contribution, the management is pleased to promote you from {{old_designation}} to {{new_designation}} with effect from {{effective_date}}.

{{salary_change_line}}

Your new responsibilities will be communicated to you by your reporting authority. All other terms and conditions of your employment remain unchanged.

Congratulations on your well-deserved promotion. We are confident you will continue to perform with the same dedication.`
  },
  {
    letter_type: "transfer",
    name: "Transfer Order",
    subject: "Transfer Order",
    body: `Dear {{salutation}} {{employee_last_name}},

In the interest of the company's operations, you are hereby transferred from {{old_department}} to {{new_department}} {{new_branch_line}}with effect from {{effective_date}}.

{{supervisor_line}}

You are requested to hand over your current responsibilities properly and report to your new place of work on the effective date. All other terms and conditions of your employment remain unchanged.`
  },
  {
    letter_type: "increment",
    name: "Increment Letter",
    subject: "Salary Increment",
    body: `Dear {{salutation}} {{employee_last_name}},

We are pleased to inform you that the management has approved an increment of BDT {{increment_amount}} ({{increment_percent}}%) on your monthly gross salary with effect from {{effective_date}}.

Your revised monthly gross salary will be BDT {{new_gross}} ({{new_gross_words}}), up from BDT {{old_gross}}.

We appreciate your efforts and hope you will continue to contribute with the same commitment.`
  },
  {
    letter_type: "bank_account",
    name: "Bank Account Opening Letter",
    subject: "Introduction for Opening a Salary Account",
    body: `The Manager
{{bank_name}}
{{bank_branch}}

Dear Sir/Madam,

This is to introduce {{salutation}} {{employee_name}}, {{designation}}, Employee ID {{employee_code}}, who has been working with {{company_name}} since {{joining_date}}.

We request you to kindly open a salary account in {{his_her}} name. {{his_her_cap}} monthly salary will be credited to this account by the company.

Kindly send the account details to the undersigned at your earliest convenience.

Your cooperation in this regard will be highly appreciated.`
  },
  {
    letter_type: "salary_certificate",
    name: "Salary Certificate",
    subject: "Salary Certificate",
    body: `TO WHOM IT MAY CONCERN

This is to certify that {{salutation}} {{employee_name}}, Employee ID {{employee_code}}, has been working with {{company_name}} as {{designation}} in the {{department}} department since {{joining_date}}.

{{his_her_cap}} current monthly salary is as follows:

Basic Salary: BDT {{basic_salary}}
House Rent: BDT {{house_rent}}
Medical Allowance: BDT {{medical_allowance}}
Conveyance: BDT {{conveyance_allowance}}
Gross Salary: BDT {{gross_salary}} ({{gross_salary_words}})

This certificate is issued on {{his_her}} request for {{purpose}}.`
  },
  {
    letter_type: "experience",
    name: "Experience Certificate",
    subject: "Experience Certificate",
    body: `TO WHOM IT MAY CONCERN

This is to certify that {{salutation}} {{employee_name}}, Employee ID {{employee_code}}, has been working with {{company_name}} from {{joining_date}} {{service_until_line}}. {{his_her_cap}} present designation is {{designation}} in the {{department}} department.

During {{his_her}} service {{he_she}} has been found sincere, hardworking and honest. To the best of our knowledge {{he_she}} bears a good moral character.

We wish {{him_her}} every success in life.`
  },
  {
    letter_type: "release",
    name: "Release Letter",
    subject: "Release Letter",
    body: `Dear {{salutation}} {{employee_last_name}},

With reference to your resignation, the management has accepted it and you are hereby released from the services of {{company_name}} at the close of business on {{last_working_day}}.

Your final settlement will be processed after completion of the clearance formalities.

We thank you for your service and wish you success in your future endeavours.`
  },
  {
    letter_type: "noc",
    name: "No Objection Certificate",
    subject: "No Objection Certificate",
    body: `TO WHOM IT MAY CONCERN

This is to certify that {{salutation}} {{employee_name}}, {{designation}}, Employee ID {{employee_code}}, is a permanent employee of {{company_name}} since {{joining_date}}.

The company has no objection to {{his_her}} {{purpose}}.

This certificate is issued on {{his_her}} request.`
  },
  {
    letter_type: "general",
    name: "General Office Order",
    subject: "{{action_label}}",
    body: `Dear {{salutation}} {{employee_last_name}},

This is to inform you that the management has approved the following with effect from {{effective_date}}:

{{action_summary}}

{{reason_line}}

All other terms and conditions of your employment remain unchanged.`
  }
];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function ensureHROperationsSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  const tables: [string, string][] = [
    [
      "hr_ops_settings",
      `CREATE TABLE IF NOT EXISTS hr_ops_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        setting_key VARCHAR(100) NOT NULL UNIQUE,
        setting_value TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    ],
    [
      "hr_employee_service",
      `CREATE TABLE IF NOT EXISTS hr_employee_service (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL UNIQUE,
        grade VARCHAR(100) NULL,
        probation_months INT NULL,
        probation_end_date DATE NULL,
        confirmation_date DATE NULL,
        contract_end_date DATE NULL,
        -- probation / confirmed / contract / suspended / separated
        service_status VARCHAR(30) NULL,
        updated_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE
      )`
    ],
    [
      "hr_action_approval_steps",
      `CREATE TABLE IF NOT EXISTS hr_action_approval_steps (
        id INT AUTO_INCREMENT PRIMARY KEY,
        -- An HR action type key, or 'default' (used for every type with no
        -- chain of its own).
        action_type VARCHAR(40) NOT NULL,
        step_order INT NOT NULL,
        label VARCHAR(100) NULL,
        -- JSON array of users.id — any ONE of them clears the step.
        approver_user_ids TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    ],
    [
      "hr_actions",
      `CREATE TABLE IF NOT EXISTS hr_actions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        action_type VARCHAR(40) NOT NULL,
        effective_date DATE NOT NULL,
        -- pending / approved / rejected / cancelled
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        -- 1 once every change has been written to the Employee (an approved
        -- action dated in the future waits for its date).
        applied TINYINT(1) NOT NULL DEFAULT 0,
        current_step INT NOT NULL DEFAULT 1,
        total_steps INT NOT NULL DEFAULT 0,
        chain_json TEXT NULL,
        history_json TEXT NULL,
        from_json TEXT NULL,
        to_json TEXT NULL,
        reason TEXT NULL,
        remarks TEXT NULL,
        batch_id VARCHAR(40) NULL,
        transfer_id INT NULL,
        salary_structure_id INT NULL,
        letter_id INT NULL,
        created_by INT NULL,
        decided_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )`
    ],
    [
      "hr_letter_templates",
      `CREATE TABLE IF NOT EXISTS hr_letter_templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        letter_type VARCHAR(40) NOT NULL,
        name VARCHAR(150) NOT NULL,
        subject VARCHAR(255) NOT NULL,
        body MEDIUMTEXT NOT NULL,
        is_default TINYINT(1) NOT NULL DEFAULT 0,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        updated_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`
    ],
    [
      "hr_letters",
      `CREATE TABLE IF NOT EXISTS hr_letters (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ref_no VARCHAR(100) NOT NULL,
        employee_id INT NOT NULL,
        letter_type VARCHAR(40) NOT NULL,
        template_id INT NULL,
        subject VARCHAR(255) NOT NULL,
        body MEDIUMTEXT NOT NULL,
        letter_date DATE NOT NULL,
        hr_action_id INT NULL,
        request_id INT NULL,
        issued_by INT NULL,
        -- issued / cancelled
        status VARCHAR(20) NOT NULL DEFAULT 'issued',
        requires_ack TINYINT(1) NOT NULL DEFAULT 1,
        acknowledged_at TIMESTAMP NULL,
        ack_note VARCHAR(500) NULL,
        cancelled_reason VARCHAR(500) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
        FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE SET NULL
      )`
    ],
    [
      "hr_letter_requests",
      `CREATE TABLE IF NOT EXISTS hr_letter_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        user_id INT NOT NULL,
        letter_type VARCHAR(40) NOT NULL,
        purpose VARCHAR(500) NULL,
        -- pending / issued / rejected
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        letter_id INT NULL,
        handled_by INT NULL,
        handled_at TIMESTAMP NULL,
        remarks VARCHAR(500) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`
    ],
    [
      "hr_onboarding_tasks",
      `CREATE TABLE IF NOT EXISTS hr_onboarding_tasks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        task_key VARCHAR(60) NOT NULL,
        label VARCHAR(200) NOT NULL,
        category VARCHAR(60) NULL,
        -- Days after the joining date the item is due (negative = before).
        due_days INT NOT NULL DEFAULT 0,
        sort_order INT NOT NULL DEFAULT 0,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    ],
    [
      "hr_onboarding_items",
      `CREATE TABLE IF NOT EXISTS hr_onboarding_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        task_key VARCHAR(60) NOT NULL,
        label VARCHAR(200) NOT NULL,
        category VARCHAR(60) NULL,
        sort_order INT NOT NULL DEFAULT 0,
        -- pending / done / na
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        due_date DATE NULL,
        note VARCHAR(500) NULL,
        value_text VARCHAR(255) NULL,
        attachment_name VARCHAR(255) NULL,
        attachment_mime VARCHAR(100) NULL,
        attachment_data LONGBLOB NULL,
        done_by INT NULL,
        done_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE
      )`
    ],
    [
      "hr_increment_policies",
      `CREATE TABLE IF NOT EXISTS hr_increment_policies (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        -- anniversary (each Employee's joining anniversary) / fixed_month
        basis VARCHAR(20) NOT NULL DEFAULT 'anniversary',
        fixed_month INT NULL,
        min_service_months INT NOT NULL DEFAULT 12,
        default_percent DECIMAL(6,2) NOT NULL DEFAULT 5.00,
        department_id INT NULL,
        grade VARCHAR(100) NULL,
        job_base VARCHAR(50) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  // Seed defaults once (only when the table is still empty).
  try {
    const [tpl]: any = await dbPool.query("SELECT COUNT(*) AS cnt FROM hr_letter_templates");
    if (Number(tpl[0]?.cnt || 0) === 0) {
      for (const t of DEFAULT_TEMPLATES) {
        await dbPool.query(
          "INSERT INTO hr_letter_templates (letter_type, name, subject, body, is_default, is_active) VALUES (?, ?, ?, ?, 1, 1)",
          [t.letter_type, t.name, t.subject, t.body]
        );
      }
    }
    const [tasks]: any = await dbPool.query("SELECT COUNT(*) AS cnt FROM hr_onboarding_tasks");
    if (Number(tasks[0]?.cnt || 0) === 0) {
      let i = 0;
      for (const t of DEFAULT_ONBOARDING_TASKS) {
        await dbPool.query(
          "INSERT INTO hr_onboarding_tasks (task_key, label, category, due_days, sort_order, is_active) VALUES (?, ?, ?, ?, ?, 1)",
          [t.task_key, t.label, t.category, t.due_days, ++i]
        );
      }
    }
  } catch (err: any) {
    console.warn("⚠️ Could not seed HR Operations defaults: " + err.message);
  }
}

// In-memory fallback DB (no MySQL): same default rows, pushed straight into
// the arrays memoryDbFallback.ts registers for these tables.
export function seedHROperationsMemory(templates: any[], tasks: any[]) {
  if (templates.length === 0) {
    DEFAULT_TEMPLATES.forEach((t, i) =>
      templates.push({ id: i + 1, ...t, is_default: 1, is_active: 1, created_at: new Date(), updated_at: new Date() })
    );
  }
  if (tasks.length === 0) {
    DEFAULT_ONBOARDING_TASKS.forEach((t, i) => tasks.push({ id: i + 1, ...t, sort_order: i + 1, is_active: 1, created_at: new Date() }));
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export const toDate = (v: any): string | null => {
  if (!v) return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
export const parseJson = (v: any, fallback: any) => {
  if (v == null || v === "") return fallback;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};
export const num = (v: any): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const money = (v: any): string => {
  const n = num(v);
  return n === null ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (d: string | null): string => {
  if (!d) return "—";
  const [y, m, day] = d.split("-").map(Number);
  return `${String(day).padStart(2, "0")} ${MONTHS[m - 1]} ${y}`;
};
const addMonths = (d: string, months: number): string => {
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(day, last));
  return dt.toISOString().slice(0, 10);
};
const addDays = (d: string, days: number): string => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day + days)).toISOString().slice(0, 10);
};
export const monthsBetween = (from: string, to: string): number => {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
};

// Taka amount in words (Bangladeshi Lakh/Crore grouping), used by
// {{gross_salary_words}} / {{new_gross_words}}.
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function twoDigits(n: number): string {
  return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
}
function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? ONES[h] + " Hundred" : "", r ? twoDigits(r) : ""].filter(Boolean).join(" ");
}
export function takaInWords(value: any): string {
  const n = Math.round(Number(value) || 0);
  if (n === 0) return "Taka Zero Only";
  let rest = n;
  const crore = Math.floor(rest / 10000000);
  rest %= 10000000;
  const lakh = Math.floor(rest / 100000);
  rest %= 100000;
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;
  const parts = [
    crore ? threeDigits(crore) + " Crore" : "",
    lakh ? twoDigits(lakh) + " Lakh" : "",
    thousand ? twoDigits(thousand) + " Thousand" : "",
    rest ? threeDigits(rest) : ""
  ].filter(Boolean);
  return "Taka " + parts.join(" ") + " Only";
}

// ---------------------------------------------------------------------------
// Shared data loaders
// ---------------------------------------------------------------------------

export async function loadSettings(queryDB: QueryDB): Promise<Record<string, string>> {
  const rows: any[] = await queryDB("SELECT * FROM hr_ops_settings").catch(() => []);
  const out: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.setting_key] = r.setting_value ?? "";
  return out;
}

interface EmployeeSnapshot {
  employee: any;
  service: any | null;
  salary: any | null;
  supervisor: { id: number; name: string } | null;
  project: { id: number; name: string } | null;
}

export async function loadEmployeeWorld(queryDB: QueryDB) {
  const [employees, services, salaries, supervisors, users, projects, departments, branches] = await Promise.all([
    queryDB("SELECT * FROM all_employees"),
    queryDB("SELECT * FROM hr_employee_service").catch(() => []),
    queryDB("SELECT * FROM salary_structures").catch(() => []),
    queryDB("SELECT * FROM employee_supervisors").catch(() => []),
    queryDB("SELECT * FROM users").catch(() => []),
    queryDB("SELECT * FROM projects").catch(() => []),
    queryDB("SELECT * FROM departments").catch(() => []),
    queryDB("SELECT * FROM branches").catch(() => [])
  ]);
  return { employees, services, salaries, supervisors, users, projects, departments, branches };
}
type World = Awaited<ReturnType<typeof loadEmployeeWorld>>;

function latestSalary(world: World, employeeId: number, asOf?: string): any | null {
  const rows = world.salaries
    .filter((s: any) => Number(s.employee_id) === employeeId && (!asOf || (toDate(s.effective_date) || "") <= asOf))
    .sort((a: any, b: any) => (toDate(b.effective_date) || "").localeCompare(toDate(a.effective_date) || "") || Number(b.id) - Number(a.id));
  return rows[0] || null;
}

export function snapshotOf(world: World, employeeId: number, asOf?: string): EmployeeSnapshot | null {
  const employee = world.employees.find((e: any) => Number(e.id) === employeeId);
  if (!employee) return null;
  const service = world.services.find((s: any) => Number(s.employee_id) === employeeId) || null;
  const supRow = world.supervisors
    .filter((s: any) => Number(s.employee_id) === employeeId && Number(s.is_direct) === 1)
    .sort((a: any, b: any) => Number(b.id) - Number(a.id))[0];
  const supEmp = supRow ? world.employees.find((e: any) => Number(e.id) === Number(supRow.supervisor_id)) : null;
  const user = employee.user_id ? world.users.find((u: any) => Number(u.id) === Number(employee.user_id)) : null;
  const project = user?.attendance_project_id ? world.projects.find((p: any) => Number(p.id) === Number(user.attendance_project_id)) : null;
  return {
    employee,
    service,
    salary: latestSalary(world, employeeId, asOf),
    supervisor: supEmp ? { id: Number(supEmp.id), name: supEmp.name } : null,
    project: project ? { id: Number(project.id), name: project.project_name } : null
  };
}

// The Employee's current values in the same shape an action's from/to use.
export function currentValues(snap: EmployeeSnapshot) {
  const e = snap.employee;
  return {
    designation: e.designation || null,
    department_id: e.department_id != null ? Number(e.department_id) : null,
    department: e.department || null,
    branch_id: e.branch_id != null ? Number(e.branch_id) : null,
    branch: e.branch || null,
    supervisor_id: snap.supervisor?.id ?? null,
    supervisor: snap.supervisor?.name ?? null,
    grade: snap.service?.grade || null,
    gross_salary: snap.salary ? Number(snap.salary.gross_salary) : null,
    basic_salary: snap.salary ? Number(snap.salary.basic_salary) : null,
    probation_end_date: toDate(snap.service?.probation_end_date),
    contract_end_date: toDate(snap.service?.contract_end_date),
    job_base: e.job_base || null,
    service_status: snap.service?.service_status || null
  };
}

async function upsertService(queryDB: QueryDB, employeeId: number, patch: Record<string, any>, actorId: number | null) {
  const rows: any[] = await queryDB("SELECT * FROM hr_employee_service");
  const existing = rows.find((r: any) => Number(r.employee_id) === employeeId);
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  if (existing) {
    await queryDB(
      `UPDATE hr_employee_service SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_by = ? WHERE id = ?`,
      [...keys.map((k) => patch[k]), actorId, existing.id]
    );
  } else {
    await queryDB(
      `INSERT INTO hr_employee_service (employee_id, ${keys.join(", ")}, updated_by) VALUES (?, ${keys.map(() => "?").join(", ")}, ?)`,
      [employeeId, ...keys.map((k) => patch[k]), actorId]
    );
  }
}

// ---------------------------------------------------------------------------
// Applying an approved action
// ---------------------------------------------------------------------------

// Salary part — inserted as soon as the action is approved (Payroll already
// picks each month's structure by effective_date, so an early insert is
// correct). Components are scaled from the previous structure so the
// Basic/House Rent/… split is kept; a first-ever structure uses the common
// 60/30/6/4 split.
async function insertSalaryRevision(queryDB: QueryDB, world: World, action: any, to: any, actorId: number | null): Promise<number | null> {
  const newGross = num(to.gross_salary);
  if (newGross === null || newGross <= 0) return null;
  const eff = toDate(action.effective_date)!;
  const prev = latestSalary(world, Number(action.employee_id));
  let basic: number, house: number, medical: number, conveyance: number, other: number, tax: number, pf: number;
  const newBasic = num(to.basic_salary);
  if (prev && Number(prev.gross_salary) > 0) {
    const ratio = newGross / Number(prev.gross_salary);
    basic = newBasic ?? Math.round(Number(prev.basic_salary) * ratio);
    house = Math.round(Number(prev.house_rent) * ratio);
    medical = Math.round(Number(prev.medical_allowance) * ratio);
    conveyance = Math.round(Number(prev.conveyance_allowance) * ratio);
    tax = Number(prev.tax_deduction) || 0;
    pf = Number(prev.basic_salary) > 0 ? Math.round((Number(prev.pf_deduction) || 0) * (basic / Number(prev.basic_salary))) : Number(prev.pf_deduction) || 0;
  } else {
    basic = newBasic ?? Math.round(newGross * 0.6);
    house = Math.round(newGross * 0.3);
    medical = Math.round(newGross * 0.06);
    conveyance = Math.round(newGross * 0.04);
    tax = 0;
    pf = 0;
  }
  other = Math.max(0, newGross - basic - house - medical - conveyance);
  if (basic + house + medical + conveyance > newGross) {
    // A typed Basic larger than the scaled split allows — squeeze house rent.
    house = Math.max(0, newGross - basic - medical - conveyance);
    other = Math.max(0, newGross - basic - house - medical - conveyance);
  }
  const result = await queryDB(
    `INSERT INTO salary_structures (employee_id, basic_salary, house_rent, medical_allowance, conveyance_allowance, other_allowance, gross_salary, tax_deduction, pf_deduction, effective_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [action.employee_id, basic, house, medical, conveyance, other, newGross, tax, pf, eff, actorId]
  );
  return result?.insertId ? Number(result.insertId) : null;
}

// Department / Designation / Supervisor — recorded as an employee_transfers
// row (applied = 0) and handed to the existing lazy sweep, which applies it
// right away when the date has come and otherwise on the date.
async function recordTransferPart(queryDB: QueryDB, action: any, from: any, to: any, actorId: number | null, today: string): Promise<number | null> {
  const deptChanges = to.department_id !== undefined && Number(to.department_id || 0) !== Number(from.department_id || 0);
  const desigChanges = !!to.designation && to.designation !== from.designation;
  const supChanges = to.supervisor_id !== undefined && to.supervisor_id !== null && Number(to.supervisor_id) !== Number(from.supervisor_id || 0);
  if (!deptChanges && !desigChanges && !supChanges) return null;
  const result = await queryDB(
    `INSERT INTO employee_transfers
     (employee_id, from_department_id, from_department_name, to_department_id, to_department_name,
      from_designation, to_designation, from_supervisor_id, to_supervisor_id, effective_date, reason, action_by, applied)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      action.employee_id,
      from.department_id ?? null,
      from.department ?? null,
      deptChanges ? to.department_id ?? null : from.department_id ?? null,
      deptChanges ? to.department ?? null : from.department ?? null,
      from.designation ?? null,
      desigChanges ? to.designation : from.designation ?? null,
      from.supervisor_id ?? null,
      supChanges ? Number(to.supervisor_id) : null,
      toDate(action.effective_date),
      `HR Action #${action.id}: ${ACTION_LABEL.get(action.action_type) || action.action_type}${action.reason ? " — " + String(action.reason).slice(0, 180) : ""}`,
      actorId
    ]
  );
  await applyDueEmployeeTransfers(queryDB, today);
  return result?.insertId ? Number(result.insertId) : null;
}

// Everything that has to wait for the Effective Date (grade, branch,
// probation, contract, service status, separation).
async function applyServicePart(queryDB: QueryDB, action: any, to: any, actorId: number | null) {
  const eff = toDate(action.effective_date)!;
  const empId = Number(action.employee_id);
  const service: Record<string, any> = {};
  if (to.grade !== undefined && to.grade !== null && to.grade !== "") service.grade = String(to.grade).slice(0, 100);
  if (to.probation_end_date) service.probation_end_date = to.probation_end_date;
  if (to.contract_end_date) service.contract_end_date = to.contract_end_date;
  switch (action.action_type) {
    case "confirmation":
      service.confirmation_date = eff;
      service.service_status = "confirmed";
      await queryDB("UPDATE all_employees SET job_base = ?, job_base_effective_date = ? WHERE id = ?", ["Permanent", eff, empId]);
      break;
    case "probation_extension":
      service.service_status = "probation";
      break;
    case "contract_renewal":
      service.service_status = "contract";
      break;
    case "suspension":
      service.service_status = "suspended";
      if (to.block_login) await blockEmployeeLogin(queryDB, empId, `Suspended from ${eff}`, actorId);
      break;
    case "company_transfer":
      if (to.company_id) await applyCompanyTransfer(queryDB, empId, Number(to.company_id), to.employee_code || null);
      break;
    case "resignation":
    case "termination":
    case "retirement":
      service.service_status = "separated";
      await queryDB("UPDATE all_employees SET job_status = ?, job_status_effective_date = ?, is_active = ? WHERE id = ?", [
        action.action_type === "resignation" ? "Resigned" : action.action_type === "termination" ? "Terminated" : "Inactive",
        eff,
        0,
        empId
      ]);
      // A separated employee can no longer sign in (AccountBlock.ts).
      await blockEmployeeLogin(queryDB, empId, `${ACTION_LABEL.get(action.action_type) || "Separated"} from ${eff}`, actorId);
      break;
  }
  if (to.branch_id !== undefined && to.branch_id !== null && to.branch_id !== "") {
    await queryDB("UPDATE all_employees SET branch_id = ?, branch = ? WHERE id = ?", [Number(to.branch_id), to.branch ?? null, empId]);
  }
  if (Object.keys(service).length > 0) await upsertService(queryDB, empId, service, actorId);
}

// Final approval: salary + transfer parts now, the rest now or on its date.
async function onActionApproved(queryDB: QueryDB, action: any, actorId: number | null, today: string) {
  const world = await loadEmployeeWorld(queryDB);
  const from = parseJson(action.from_json, {});
  const to = parseJson(action.to_json, {});
  const salaryId = await insertSalaryRevision(queryDB, world, action, to, actorId);
  const transferId = await recordTransferPart(queryDB, action, from, to, actorId, today);
  const due = (toDate(action.effective_date) || "") <= today;
  if (due) await applyServicePart(queryDB, action, to, actorId);
  await queryDB("UPDATE hr_actions SET salary_structure_id = ?, transfer_id = ?, applied = ? WHERE id = ?", [
    salaryId,
    transferId,
    due ? 1 : 0,
    action.id
  ]);
}

// Lazy sweep (no scheduler in this codebase) — approved actions whose date
// has now arrived.
export async function applyDueHrActions(queryDB: QueryDB, today: string): Promise<void> {
  try {
    const rows: any[] = await queryDB("SELECT * FROM hr_actions");
    const due = rows
      .filter((a: any) => a.status === "approved" && !Number(a.applied) && (toDate(a.effective_date) || "9999") <= today)
      .sort((a: any, b: any) => (toDate(a.effective_date) || "").localeCompare(toDate(b.effective_date) || "") || Number(a.id) - Number(b.id));
    for (const a of due) {
      await applyServicePart(queryDB, a, parseJson(a.to_json, {}), null);
      await queryDB("UPDATE hr_actions SET applied = ? WHERE id = ?", [1, a.id]);
    }
  } catch (err: any) {
    console.warn("⚠️ Could not apply due HR actions: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// Approval chain
// ---------------------------------------------------------------------------

async function chainFor(queryDB: QueryDB, actionType: string) {
  const rows: any[] = await queryDB("SELECT * FROM hr_action_approval_steps").catch(() => []);
  const own = rows.filter((r: any) => r.action_type === actionType);
  const use = own.length > 0 ? own : rows.filter((r: any) => r.action_type === "default");
  return use
    .sort((a: any, b: any) => Number(a.step_order) - Number(b.step_order))
    .map((r: any, i: number) => ({
      step_order: i + 1,
      label: r.label || `Step ${i + 1}`,
      approver_ids: (parseJson(r.approver_user_ids, []) as any[]).map(Number).filter((n) => Number.isFinite(n))
    }))
    .filter((s: any) => s.approver_ids.length > 0);
}

function describeChange(action: any, employeeName?: string): string {
  const from = parseJson(action.from_json, {});
  const to = parseJson(action.to_json, {});
  const bits: string[] = [];
  if (to.designation && to.designation !== from.designation) bits.push(`${from.designation || "—"} → ${to.designation}`);
  if (to.department_id !== undefined && Number(to.department_id || 0) !== Number(from.department_id || 0)) bits.push(`${from.department || "—"} → ${to.department || "—"}`);
  if (to.branch && to.branch !== from.branch) bits.push(`${from.branch || "—"} → ${to.branch}`);
  if (to.supervisor && to.supervisor !== from.supervisor) bits.push(`Supervisor: ${to.supervisor}`);
  if (to.grade && to.grade !== from.grade) bits.push(`Grade ${from.grade || "—"} → ${to.grade}`);
  if (num(to.gross_salary) !== null) bits.push(`Gross ${money(from.gross_salary)} → ${money(to.gross_salary)}`);
  if (to.probation_end_date) bits.push(`Probation until ${to.probation_end_date}`);
  if (to.contract_end_date) bits.push(`Contract until ${to.contract_end_date}`);
  const label = ACTION_LABEL.get(action.action_type) || action.action_type;
  return `${label}${employeeName ? " — " + employeeName : ""}${bits.length ? ": " + bits.join(", ") : ""} (eff. ${toDate(action.effective_date)})`;
}

// Items for GET /api/my-approvals (ApprovalRoutes.ts) — HR actions whose
// current step lists this account.
export async function getMyHrActionApprovals(queryDB: QueryDB, userId: number): Promise<any[]> {
  try {
    const [actions, employees, users] = await Promise.all([
      queryDB("SELECT * FROM hr_actions"),
      queryDB("SELECT * FROM all_employees"),
      queryDB("SELECT * FROM users")
    ]);
    const empMap = new Map<number, any>(employees.map((e: any) => [Number(e.id), e]));
    const userMap = new Map<number, any>(users.map((u: any) => [Number(u.id), u]));
    return actions
      .filter((a: any) => a.status === "pending")
      .filter((a: any) => {
        const chain = parseJson(a.chain_json, []);
        const step = chain.find((s: any) => Number(s.step_order) === Number(a.current_step));
        return !!step && (step.approver_ids || []).map(Number).includes(Number(userId));
      })
      .map((a: any) => {
        const emp = empMap.get(Number(a.employee_id));
        return {
          id: Number(a.id),
          source_type: "hr_action",
          source_id: Number(a.id),
          source_label: describeChange(a, emp?.name),
          source_amount: null,
          requested_by: a.created_by,
          requested_by_name: userMap.get(Number(a.created_by))?.name || null,
          current_step: Number(a.current_step),
          total_steps: Number(a.total_steps),
          created_at: a.created_at,
          hr_action_details: {
            action_type: a.action_type,
            action_label: ACTION_LABEL.get(a.action_type) || a.action_type,
            employee_name: emp?.name || null,
            employee_code: emp?.employee_id || null,
            effective_date: toDate(a.effective_date),
            reason: a.reason || null,
            from: parseJson(a.from_json, {}),
            to: parseJson(a.to_json, {}),
            history: parseJson(a.history_json, [])
          }
        };
      });
  } catch (err: any) {
    console.warn("⚠️ Could not list HR action approvals: " + err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------

async function nextRefNo(queryDB: QueryDB, settings: Record<string, string>, letterType: string, letterDate: string): Promise<string> {
  const year = letterDate.slice(0, 4);
  const letters: any[] = await queryDB("SELECT * FROM hr_letters");
  const code = LETTER_CODE.get(letterType) || "GEN";
  const sameSeries = letters.filter((l: any) => l.letter_type === letterType && (toDate(l.letter_date) || "").slice(0, 4) === year);
  let seq = sameSeries.length + 1;
  const build = (n: number) =>
    (settings.ref_format || DEFAULT_SETTINGS.ref_format)
      .replace(/\{CODE\}/g, settings.company_code || "CHL")
      .replace(/\{TYPE\}/g, code)
      .replace(/\{YYYY\}/g, year)
      .replace(/\{YY\}/g, year.slice(2))
      .replace(/\{MM\}/g, letterDate.slice(5, 7))
      .replace(/\{SEQ\}/g, String(n).padStart(4, "0"));
  const used = new Set(letters.map((l: any) => l.ref_no));
  while (used.has(build(seq))) seq++;
  return build(seq);
}

async function buildPlaceholders(
  queryDB: QueryDB,
  employeeId: number,
  opts: { action?: any; letterDate: string; extra?: Record<string, any> }
): Promise<Record<string, string>> {
  const settings = await loadSettings(queryDB);
  const world = await loadEmployeeWorld(queryDB);
  const snap = snapshotOf(world, employeeId);
  if (!snap) throw new Error("Employee not found.");
  const e = snap.employee;
  const cur = currentValues(snap);
  const gender = String(e.gender || "").toLowerCase();
  const female = gender.startsWith("f");
  const male = gender.startsWith("m");
  const nameParts = String(e.name || "").trim().split(/\s+/);
  const joining = toDate(e.joining_date);
  const salary = snap.salary;
  const accounts: any[] = await queryDB("SELECT * FROM employee_payment_accounts").catch(() => []);
  const bank = accounts.find((a: any) => Number(a.employee_id) === employeeId && a.account_type === "bank" && Number(a.is_active) !== 0);
  const extra = opts.extra || {};
  const map: Record<string, string> = {
    company_name: settings.company_name,
    company_address: settings.company_address,
    signatory_name: settings.signatory_name,
    signatory_designation: settings.signatory_designation,
    today: longDate(opts.letterDate),
    letter_date: longDate(opts.letterDate),
    employee_name: e.name || "",
    employee_last_name: nameParts[nameParts.length - 1] || e.name || "",
    employee_code: e.employee_id || "",
    salutation: female ? "Ms." : male ? "Mr." : "Mr./Ms.",
    he_she: female ? "she" : male ? "he" : "he/she",
    him_her: female ? "her" : male ? "him" : "him/her",
    his_her: female ? "her" : male ? "his" : "his/her",
    his_her_cap: female ? "Her" : male ? "His" : "His/Her",
    designation: e.designation || "",
    department: e.department || "concerned",
    branch: e.branch || "our Head Office",
    grade: cur.grade || "",
    project: snap.project?.name || "",
    supervisor: snap.supervisor?.name || "",
    joining_date: longDate(joining),
    present_address: [e.present_address, e.present_city].filter(Boolean).join(", "),
    probation_months: String(snap.service?.probation_months ?? settings.default_probation_months ?? "6"),
    probation_end_date: longDate(toDate(snap.service?.probation_end_date) || (joining ? addMonths(joining, Number(snap.service?.probation_months ?? settings.default_probation_months ?? 6)) : null)),
    confirmation_date: longDate(toDate(snap.service?.confirmation_date)),
    contract_end_date: longDate(toDate(snap.service?.contract_end_date)),
    basic_salary: money(salary?.basic_salary),
    house_rent: money(salary?.house_rent),
    medical_allowance: money(salary?.medical_allowance),
    conveyance_allowance: money(salary?.conveyance_allowance),
    gross_salary: money(salary?.gross_salary),
    gross_salary_words: salary ? takaInWords(salary.gross_salary) : "",
    bank_name: extra.bank_name || bank?.bank_name || "________________",
    bank_branch: extra.bank_branch || bank?.branch_name || "________________ Branch",
    purpose: extra.purpose || "official purposes",
    last_working_day: longDate(extra.last_working_day || null),
    service_until_line: e.is_active === 0 || Number(e.is_active) === 0 ? `to ${longDate(toDate(e.job_status_effective_date))}` : "to date",
    effective_date: longDate(opts.letterDate),
    action_label: "",
    action_summary: "",
    reason_line: "",
    old_designation: e.designation || "",
    new_designation: e.designation || "",
    old_department: e.department || "",
    new_department: e.department || "",
    new_branch_line: "",
    supervisor_line: "",
    old_gross: money(salary?.gross_salary),
    new_gross: money(salary?.gross_salary),
    new_gross_words: salary ? takaInWords(salary.gross_salary) : "",
    increment_amount: "0",
    increment_percent: "0",
    salary_change_line: ""
  };
  const a = opts.action;
  if (a) {
    const from = parseJson(a.from_json, {});
    const to = parseJson(a.to_json, {});
    const eff = toDate(a.effective_date);
    map.effective_date = longDate(eff);
    map.action_label = ACTION_LABEL.get(a.action_type) || a.action_type;
    map.action_summary = describeChange(a).replace(/ \(eff\. .*\)$/, "");
    map.reason_line = a.reason ? `Reason: ${a.reason}` : "";
    map.old_designation = from.designation || e.designation || "";
    map.new_designation = to.designation || from.designation || e.designation || "";
    map.old_department = from.department || e.department || "";
    map.new_department = to.department || from.department || e.department || "";
    map.new_branch_line = to.branch && to.branch !== from.branch ? `(${to.branch}) ` : "";
    map.supervisor_line = to.supervisor ? `You will report to ${to.supervisor}.` : "";
    if (SEPARATION_TYPES.has(a.action_type)) map.last_working_day = longDate(eff);
    const oldG = num(from.gross_salary);
    const newG = num(to.gross_salary);
    if (newG !== null) {
      map.old_gross = money(oldG);
      map.new_gross = money(newG);
      map.new_gross_words = takaInWords(newG);
      if (oldG !== null && oldG > 0) {
        map.increment_amount = money(newG - oldG);
        map.increment_percent = (((newG - oldG) / oldG) * 100).toFixed(2).replace(/\.00$/, "");
      }
      map.salary_change_line = `Consequently, your monthly gross salary has been revised to BDT ${money(newG)} (${takaInWords(newG)}) from BDT ${money(oldG)}.`;
    }
  }
  return map;
}

function renderTemplate(text: string, map: Record<string, string>): string {
  return String(text || "")
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key) => (key in map ? map[key] : m))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const PLACEHOLDER_HELP: { key: string; label: string }[] = [
  { key: "employee_name", label: "Full name" },
  { key: "employee_last_name", label: "Last name" },
  { key: "employee_code", label: "Employee ID" },
  { key: "salutation", label: "Mr./Ms." },
  { key: "designation", label: "Current designation" },
  { key: "department", label: "Department" },
  { key: "branch", label: "Branch / place of work" },
  { key: "grade", label: "Grade" },
  { key: "project", label: "Project" },
  { key: "supervisor", label: "Supervisor" },
  { key: "joining_date", label: "Joining date" },
  { key: "probation_months", label: "Probation (months)" },
  { key: "probation_end_date", label: "Probation end date" },
  { key: "present_address", label: "Present address" },
  { key: "basic_salary", label: "Basic salary" },
  { key: "gross_salary", label: "Gross salary" },
  { key: "gross_salary_words", label: "Gross salary in words" },
  { key: "effective_date", label: "Action effective date" },
  { key: "old_designation", label: "Old designation" },
  { key: "new_designation", label: "New designation" },
  { key: "old_department", label: "Old department" },
  { key: "new_department", label: "New department" },
  { key: "old_gross", label: "Old gross" },
  { key: "new_gross", label: "New gross" },
  { key: "new_gross_words", label: "New gross in words" },
  { key: "increment_amount", label: "Increment amount" },
  { key: "increment_percent", label: "Increment %" },
  { key: "salary_change_line", label: "Salary change sentence" },
  { key: "last_working_day", label: "Last working day" },
  { key: "bank_name", label: "Bank name" },
  { key: "bank_branch", label: "Bank branch" },
  { key: "purpose", label: "Purpose (certificate)" },
  { key: "his_her", label: "his / her" },
  { key: "he_she", label: "he / she" },
  { key: "company_name", label: "Company name" },
  { key: "today", label: "Letter date" }
];

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// One Employee's Service Book timeline (joining, actions, transfers, salary
// revisions, letters, disciplinary, exit) — shared by the HR Operations
// routes below and Employee 360 (HrOps360Routes.ts).
export async function buildServiceBook(queryDB: QueryDB, today: string, employeeId: number, forEmployee: boolean) {
  await applyDueEmployeeTransfers(queryDB, today);
  await applyDueHrActions(queryDB, today);
  const world = await loadEmployeeWorld(queryDB);
  const snap = snapshotOf(world, employeeId);
  if (!snap) throw Object.assign(new Error("Employee not found."), { statusCode: 404 });
  const e = snap.employee;
  const [transfers, actions, letters, disciplinary, exits, users] = await Promise.all([
    queryDB("SELECT * FROM employee_transfers").catch(() => []),
    queryDB("SELECT * FROM hr_actions"),
    queryDB("SELECT * FROM hr_letters"),
    queryDB("SELECT * FROM disciplinary_actions").catch(() => []),
    queryDB("SELECT * FROM exit_requests").catch(() => []),
    queryDB("SELECT * FROM users")
  ]);
  const userName = (id: any) => users.find((u: any) => Number(u.id) === Number(id))?.name || null;
  const events: any[] = [];
  const joining = toDate(e.joining_date) || toDate(e.created_at);
  if (joining) {
    // The position they joined in — the FROM side of their earliest
    // recorded change, or today's values when nothing has changed yet.
    const firstChange = [
      ...transfers.filter((t: any) => Number(t.employee_id) === employeeId).map((t: any) => ({ d: toDate(t.effective_date) || "", id: Number(t.id), desig: t.from_designation, dept: t.from_department_name })),
      ...actions
        .filter((a: any) => Number(a.employee_id) === employeeId && a.status === "approved")
        .map((a: any) => {
          const f = parseJson(a.from_json, {});
          return { d: toDate(a.effective_date) || "", id: Number(a.id), desig: f.designation, dept: f.department };
        })
    ].sort((x, y) => x.d.localeCompare(y.d) || x.id - y.id)[0];
    const desig = firstChange ? firstChange.desig : e.designation;
    const dept = firstChange ? firstChange.dept : e.department;
    events.push({ date: joining, kind: "joining", title: "Joined", detail: [desig, dept].filter(Boolean).join(", ") || null });
  }
  const myActions = actions.filter((a: any) => Number(a.employee_id) === employeeId && a.status !== "cancelled" && (!forEmployee || a.status === "approved"));
  const linkedTransferIds = new Set(myActions.map((a: any) => Number(a.transfer_id)).filter(Boolean));
  const linkedSalaryIds = new Set(myActions.map((a: any) => Number(a.salary_structure_id)).filter(Boolean));
  for (const a of myActions) {
    events.push({
      date: toDate(a.effective_date),
      kind: a.action_type,
      title: ACTION_LABEL.get(a.action_type) || a.action_type,
      detail: describeChange(a).replace(/^[^:]*:?\s?/, "").replace(/ \(eff\. .*\)$/, "") || null,
      status: a.status,
      applied: !!Number(a.applied),
      reason: a.reason || null,
      approved_by: parseJson(a.history_json, []).filter((h: any) => h.action === "approved").map((h: any) => h.by_name),
      action_id: Number(a.id)
    });
  }
  for (const t of transfers.filter((t: any) => Number(t.employee_id) === employeeId && !linkedTransferIds.has(Number(t.id)))) {
    const parts: string[] = [];
    if ((t.from_department_name || "") !== (t.to_department_name || "")) parts.push(`${t.from_department_name || "—"} → ${t.to_department_name || "—"}`);
    if ((t.from_designation || "") !== (t.to_designation || "")) parts.push(`${t.from_designation || "—"} → ${t.to_designation || "—"}`);
    if (t.to_supervisor_id) parts.push(`Supervisor: ${world.employees.find((x: any) => Number(x.id) === Number(t.to_supervisor_id))?.name || "—"}`);
    if (parts.length === 0) continue;
    events.push({
      date: toDate(t.effective_date),
      kind: (t.from_department_name || "") !== (t.to_department_name || "") ? "transfer" : "designation_change",
      title: (t.from_department_name || "") !== (t.to_department_name || "") ? "Transfer" : "Designation Change",
      detail: parts.join(", "),
      reason: t.reason || null,
      applied: !!Number(t.applied ?? 1)
    });
  }
  const mySalaries = world.salaries
    .filter((s: any) => Number(s.employee_id) === employeeId)
    .sort((a: any, b: any) => (toDate(a.effective_date) || "").localeCompare(toDate(b.effective_date) || "") || Number(a.id) - Number(b.id));
  mySalaries.forEach((s: any, i: number) => {
    if (linkedSalaryIds.has(Number(s.id))) return;
    const prev = mySalaries[i - 1];
    events.push({
      date: toDate(s.effective_date),
      kind: "salary",
      title: prev ? "Salary Revision" : "Salary Fixed",
      detail: prev ? `Gross ${money(prev.gross_salary)} → ${money(s.gross_salary)}` : `Gross ${money(s.gross_salary)}`
    });
  });
  if (!forEmployee || true) {
    for (const l of letters.filter((l: any) => Number(l.employee_id) === employeeId && l.status !== "cancelled")) {
      events.push({
        date: toDate(l.letter_date),
        kind: "letter",
        title: LETTER_LABEL.get(l.letter_type) || "Letter",
        detail: `${l.ref_no} — ${l.subject}`,
        letter_id: Number(l.id),
        acknowledged: !!l.acknowledged_at
      });
    }
  }
  if (e.user_id) {
    for (const d of disciplinary.filter((d: any) => Number(d.user_id) === Number(e.user_id))) {
      events.push({
        date: toDate(d.issued_at),
        kind: "disciplinary",
        title: "Disciplinary: " + String(d.action_type || "").replace(/_/g, " "),
        detail: d.reason || null,
        by: userName(d.issued_by)
      });
    }
    for (const x of exits.filter((x: any) => Number(x.user_id) === Number(e.user_id) && x.status !== "cancelled")) {
      events.push({
        date: toDate(x.notice_date) || toDate(x.created_at),
        kind: "exit",
        title: x.exit_type === "termination" ? "Termination Initiated" : "Resignation Submitted",
        detail: x.last_working_day ? `Last working day ${toDate(x.last_working_day)}` : null,
        reason: x.reason || null
      });
    }
  }
  if (snap.service?.confirmation_date && !myActions.some((a: any) => a.action_type === "confirmation")) {
    events.push({ date: toDate(snap.service.confirmation_date), kind: "confirmation", title: "Confirmation", detail: "Service confirmed" });
  }
  events.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const cur = currentValues(snap);
  return {
    employee: {
      id: Number(e.id),
      name: e.name,
      employee_code: e.employee_id || null,
      designation: e.designation,
      department: e.department,
      branch: e.branch,
      grade: cur.grade,
      supervisor: cur.supervisor,
      project: snap.project?.name || null,
      joining_date: joining,
      job_base: e.job_base || null,
      is_active: Number(e.is_active ?? 1) !== 0,
      gross_salary: forEmployee ? cur.gross_salary : cur.gross_salary,
      probation_end_date: toDate(snap.service?.probation_end_date),
      confirmation_date: toDate(snap.service?.confirmation_date),
      service_length_months: joining ? monthsBetween(joining, today) : null
    },
    events
  };
}

export function registerHROperationsRoutes(app: Express, deps: HROperationsRouteDeps) {
  const { authenticateToken, requireModule, queryDB, getAdminModules, todayInDhaka, createAlert } = deps;
  const gate = [authenticateToken, requireModule("hr_operations")];
  const fail = (res: any, err: any, status = 500) => res.status(err?.statusCode || status).json({ error: err?.message || String(err) });
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

  const sweep = async () => {
    const today = todayInDhaka();
    await applyDueEmployeeTransfers(queryDB, today);
    await applyDueHrActions(queryDB, today);
  };

  async function employeeForUser(userId: number) {
    const rows: any[] = await queryDB("SELECT * FROM all_employees");
    return rows.find((e: any) => Number(e.user_id) === Number(userId)) || null;
  }

  // Every account holding the hr_operations module (plus Superadmins) —
  // told about new certificate requests.
  async function hrOperators(): Promise<number[]> {
    const users: any[] = await queryDB("SELECT * FROM users");
    const out: number[] = [];
    for (const u of users) {
      if (u.role === "superadmin") out.push(Number(u.id));
      else if (u.role === "admin" || u.role === "user") {
        const mods = await getAdminModules(Number(u.id)).catch(() => []);
        if (mods.includes("hr_operations")) out.push(Number(u.id));
      }
    }
    return out;
  }

  // ---------------- meta / settings ----------------
  app.get("/api/hr-ops/meta", ...gate, async (_req: any, res: any) => {
    try {
      const [settings, users, departments, branches, projects] = await Promise.all([
        loadSettings(queryDB),
        queryDB("SELECT * FROM users"),
        queryDB("SELECT * FROM departments"),
        queryDB("SELECT * FROM branches"),
        queryDB("SELECT * FROM projects")
      ]);
      res.json({
        settings,
        action_types: HR_ACTION_TYPES,
        letter_types: LETTER_TYPES,
        placeholders: PLACEHOLDER_HELP,
        users: users.map((u: any) => ({ id: Number(u.id), name: u.name, role: u.role })),
        departments: departments.filter((d: any) => Number(d.is_active ?? 1) !== 0).map((d: any) => ({ id: Number(d.id), name: d.name })),
        branches: branches.map((b: any) => ({ id: Number(b.id), name: b.branch_name })),
        projects: projects.map((p: any) => ({ id: Number(p.id), name: p.project_name }))
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/hr-ops/settings", ...gate, async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const rows: any[] = await queryDB("SELECT * FROM hr_ops_settings");
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (body[key] === undefined) continue;
        const value = String(body[key] ?? "").slice(0, 1000);
        const existing = rows.find((r: any) => r.setting_key === key);
        if (existing) await queryDB("UPDATE hr_ops_settings SET setting_value = ? WHERE id = ?", [value, existing.id]);
        else await queryDB("INSERT INTO hr_ops_settings (setting_key, setting_value) VALUES (?, ?)", [key, value]);
      }
      res.json({ success: true, settings: await loadSettings(queryDB) });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- employees + service record ----------------
  app.get("/api/hr-ops/employees", ...gate, async (_req: any, res: any) => {
    try {
      await sweep();
      const world = await loadEmployeeWorld(queryDB);
      const settings = await loadSettings(queryDB);
      res.json(
        world.employees
          .map((e: any) => {
            const snap = snapshotOf(world, Number(e.id))!;
            const cur = currentValues(snap);
            const joining = toDate(e.joining_date);
            const probEnd =
              toDate(snap.service?.probation_end_date) ||
              (joining ? addMonths(joining, Number(snap.service?.probation_months ?? settings.default_probation_months ?? 6)) : null);
            return {
              id: Number(e.id),
              name: e.name,
              employee_code: e.employee_id || null,
              designation: e.designation || null,
              department_id: cur.department_id,
              department: e.department || null,
              branch_id: cur.branch_id,
              branch: e.branch || null,
              grade: cur.grade,
              project: snap.project?.name || null,
              supervisor_id: cur.supervisor_id,
              supervisor: cur.supervisor,
              joining_date: joining,
              is_active: Number(e.is_active ?? 1) !== 0,
              user_id: e.user_id ? Number(e.user_id) : null,
              gender: e.gender || null,
              job_base: e.job_base || null,
              employment_category: e.employment_category || null,
              gross_salary: cur.gross_salary,
              basic_salary: cur.basic_salary,
              probation_months: snap.service?.probation_months ?? null,
              probation_end_date: probEnd,
              confirmation_date: toDate(snap.service?.confirmation_date),
              contract_end_date: toDate(snap.service?.contract_end_date),
              service_status:
                snap.service?.service_status ||
                (Number(e.is_active ?? 1) === 0 ? "separated" : e.job_base === "Permanent" ? "confirmed" : e.job_base === "Contractual" ? "contract" : "probation")
            };
          })
          .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))
      );
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/hr-ops/service/:employeeId", ...gate, async (req: any, res: any) => {
    try {
      const empId = Number(req.params.employeeId);
      const emps: any[] = await queryDB("SELECT * FROM all_employees");
      const e = emps.find((x: any) => Number(x.id) === empId);
      if (!e) throw bad("Employee not found.", 404);
      const body = req.body || {};
      const patch: Record<string, any> = {};
      if (body.grade !== undefined) patch.grade = body.grade ? String(body.grade).slice(0, 100) : null;
      if (body.probation_months !== undefined) patch.probation_months = num(body.probation_months);
      if (body.probation_end_date !== undefined) patch.probation_end_date = toDate(body.probation_end_date);
      else if (patch.probation_months != null && toDate(e.joining_date)) patch.probation_end_date = addMonths(toDate(e.joining_date)!, patch.probation_months);
      if (body.confirmation_date !== undefined) patch.confirmation_date = toDate(body.confirmation_date);
      if (body.contract_end_date !== undefined) patch.contract_end_date = toDate(body.contract_end_date);
      if (body.service_status !== undefined) patch.service_status = body.service_status || null;
      await upsertService(queryDB, empId, patch, req.user.id);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- approval chain config ----------------
  app.get("/api/hr-ops/approval-steps", ...gate, async (_req: any, res: any) => {
    try {
      const rows: any[] = await queryDB("SELECT * FROM hr_action_approval_steps");
      const byType: Record<string, any[]> = {};
      for (const r of rows.sort((a: any, b: any) => Number(a.step_order) - Number(b.step_order))) {
        (byType[r.action_type] ||= []).push({ label: r.label, approver_user_ids: parseJson(r.approver_user_ids, []).map(Number) });
      }
      res.json(byType);
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/hr-ops/approval-steps/:actionType", ...gate, async (req: any, res: any) => {
    try {
      const type = String(req.params.actionType);
      if (type !== "default" && !ACTION_LABEL.has(type)) throw bad("Unknown action type.");
      const steps = Array.isArray(req.body?.steps) ? req.body.steps : null;
      if (!steps) throw bad("steps must be an array.");
      const rows: any[] = await queryDB("SELECT * FROM hr_action_approval_steps");
      for (const r of rows.filter((x: any) => x.action_type === type)) await queryDB("DELETE FROM hr_action_approval_steps WHERE id = ?", [r.id]);
      let order = 0;
      for (const s of steps) {
        const ids = (Array.isArray(s.approver_user_ids) ? s.approver_user_ids : []).map(Number).filter((n: number) => Number.isFinite(n));
        if (ids.length === 0) continue;
        await queryDB("INSERT INTO hr_action_approval_steps (action_type, step_order, label, approver_user_ids) VALUES (?, ?, ?, ?)", [
          type,
          ++order,
          String(s.label || `Step ${order}`).slice(0, 100),
          JSON.stringify(ids)
        ]);
      }
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- personnel actions ----------------
  async function createAction(body: any, actor: { id: number; name: string }, batchId: string | null) {
    const empId = Number(body.employee_id);
    const type = String(body.action_type || "");
    if (!ACTION_LABEL.has(type)) throw bad("Pick an action type.");
    const eff = toDate(body.effective_date);
    if (!eff) throw bad("Effective Date is required.");
    const world = await loadEmployeeWorld(queryDB);
    const snap = snapshotOf(world, empId);
    if (!snap) throw bad("Employee not found.", 404);
    const from: Record<string, any> = currentValues(snap);
    const raw = body.to || {};
    const to: Record<string, any> = {};
    if (raw.designation) to.designation = String(raw.designation).trim().slice(0, 255);
    if (raw.department_id !== undefined && raw.department_id !== "" && raw.department_id !== null) {
      const d = world.departments.find((x: any) => Number(x.id) === Number(raw.department_id));
      if (!d) throw bad("Department not found.");
      to.department_id = Number(d.id);
      to.department = d.name;
    }
    if (raw.branch_id !== undefined && raw.branch_id !== "" && raw.branch_id !== null) {
      const b = world.branches.find((x: any) => Number(x.id) === Number(raw.branch_id));
      if (!b) throw bad("Branch not found.");
      to.branch_id = Number(b.id);
      to.branch = b.branch_name;
    }
    if (raw.supervisor_id !== undefined && raw.supervisor_id !== "" && raw.supervisor_id !== null) {
      const s = world.employees.find((x: any) => Number(x.id) === Number(raw.supervisor_id));
      if (!s) throw bad("Supervisor not found.");
      if (Number(s.id) === empId) throw bad("An employee can't supervise themself.");
      to.supervisor_id = Number(s.id);
      to.supervisor = s.name;
    }
    if (raw.grade) to.grade = String(raw.grade).trim().slice(0, 100);
    const gross = num(raw.gross_salary);
    if (gross !== null) {
      if (gross <= 0) throw bad("Gross salary must be more than zero.");
      to.gross_salary = gross;
      if (from.gross_salary) to.increment_percent = Number((((gross - from.gross_salary) / from.gross_salary) * 100).toFixed(2));
    }
    if (num(raw.basic_salary) !== null) to.basic_salary = num(raw.basic_salary);
    if (raw.probation_end_date) to.probation_end_date = toDate(raw.probation_end_date);
    if (raw.contract_end_date) to.contract_end_date = toDate(raw.contract_end_date);
    if (type === "suspension" && raw.block_login === true) to.block_login = true;
    if (type === "increment" || type === "salary_adjustment") {
      if (to.gross_salary === undefined) throw bad("Enter the new gross salary.");
    }
    if (type === "promotion" && !to.designation && !to.grade) throw bad("A promotion needs a new designation or grade.");
    if (type === "transfer" && to.department_id === undefined && to.branch_id === undefined && to.supervisor_id === undefined) {
      throw bad("A transfer needs a new department, branch or supervisor.");
    }
    if (type === "company_transfer") {
      const companies: any[] = (await queryDB("SELECT * FROM companies").catch(() => [])) || [];
      const empRow = world.employees.find((x: any) => Number(x.id) === empId);
      const current = companies.find((c) => Number(c.id) === Number(empRow?.company_id ?? 1));
      const target = companies.find((c) => Number(c.id) === Number(raw.company_id));
      if (!target || Number(target.group_id) !== Number(current?.group_id ?? target?.group_id) || Number(target.is_active ?? 1) !== 1)
        throw bad("Pick the company to transfer to.");
      if (Number(target.id) === Number(current?.id)) throw bad("The employee already belongs to that company.");
      to.company_id = Number(target.id);
      to.company = target.name;
      from.company = current?.name || null;
      if (raw.employee_code) to.employee_code = String(raw.employee_code).trim().slice(0, 50);
      from.employee_code = empRow?.employee_id || null;
    }
    if (type === "probation_extension" && !to.probation_end_date) throw bad("Enter the new probation end date.");
    if (type === "contract_renewal" && !to.contract_end_date) throw bad("Enter the new contract end date.");

    const chain = await chainFor(queryDB, type);
    const history = [{ action: "created", by: actor.id, by_name: actor.name, at: new Date().toISOString() }];
    const result = await queryDB(
      `INSERT INTO hr_actions (employee_id, action_type, effective_date, status, applied, current_step, total_steps, chain_json, history_json, from_json, to_json, reason, remarks, batch_id, created_by)
       VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        empId,
        type,
        eff,
        chain.length === 0 ? "approved" : "pending",
        chain.length,
        JSON.stringify(chain),
        JSON.stringify(history),
        JSON.stringify(from),
        JSON.stringify(to),
        body.reason ? String(body.reason).slice(0, 2000) : null,
        body.remarks ? String(body.remarks).slice(0, 2000) : null,
        batchId,
        actor.id
      ]
    );
    const id = Number(result.insertId);
    const rows: any[] = await queryDB("SELECT * FROM hr_actions WHERE id = ?", [id]);
    const action = rows[0];
    if (chain.length === 0) {
      await onActionApproved(queryDB, action, actor.id, todayInDhaka());
    } else {
      for (const uid of chain[0].approver_ids) {
        await createAlert(queryDB, {
          userId: uid,
          type: "hr_action",
          title: `${ACTION_LABEL.get(type)} Awaiting Your Approval`,
          message: describeChange(action, snap.employee.name),
          relatedType: "hr_action",
          relatedId: id
        });
      }
    }
    return { id, status: chain.length === 0 ? "approved" : "pending" };
  }

  app.post("/api/hr-ops/actions", ...gate, async (req: any, res: any) => {
    try {
      res.json(await createAction(req.body || {}, req.user, null));
    } catch (err) {
      fail(res, err);
    }
  });

  // One reviewed list -> one Increment (or any single type) action per
  // Employee, sharing a batch id.
  app.post("/api/hr-ops/actions/bulk", ...gate, async (req: any, res: any) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (items.length === 0) throw bad("Nothing selected.");
      const batchId = `B${Date.now()}`;
      const created: any[] = [];
      const errors: any[] = [];
      for (const it of items) {
        try {
          created.push(
            await createAction(
              {
                employee_id: it.employee_id,
                action_type: req.body.action_type || "increment",
                effective_date: it.effective_date || req.body.effective_date,
                reason: it.reason || req.body.reason,
                to: it.to || { gross_salary: it.new_gross }
              },
              req.user,
              batchId
            )
          );
        } catch (e: any) {
          errors.push({ employee_id: it.employee_id, error: e.message });
        }
      }
      res.json({ success: true, batch_id: batchId, created: created.length, errors });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/hr-ops/actions", ...gate, async (_req: any, res: any) => {
    try {
      await sweep();
      const [actions, employees, users, letters] = await Promise.all([
        queryDB("SELECT * FROM hr_actions"),
        queryDB("SELECT * FROM all_employees"),
        queryDB("SELECT * FROM users"),
        queryDB("SELECT * FROM hr_letters")
      ]);
      const empMap = new Map<number, any>(employees.map((e: any) => [Number(e.id), e]));
      const userMap = new Map<number, any>(users.map((u: any) => [Number(u.id), u]));
      const letterMap = new Map<number, any>(letters.map((l: any) => [Number(l.id), l]));
      res.json(
        actions
          .sort((a: any, b: any) => Number(b.id) - Number(a.id))
          .map((a: any) => {
            const chain = parseJson(a.chain_json, []);
            const step = chain.find((s: any) => Number(s.step_order) === Number(a.current_step));
            const emp = empMap.get(Number(a.employee_id));
            return {
              id: Number(a.id),
              employee_id: Number(a.employee_id),
              employee_name: emp?.name || "(removed)",
              employee_code: emp?.employee_id || null,
              action_type: a.action_type,
              action_label: ACTION_LABEL.get(a.action_type) || a.action_type,
              effective_date: toDate(a.effective_date),
              status: a.status,
              applied: !!Number(a.applied),
              current_step: Number(a.current_step),
              total_steps: Number(a.total_steps),
              waiting_on:
                a.status === "pending" && step
                  ? { label: step.label, names: step.approver_ids.map((id: number) => userMap.get(Number(id))?.name || `#${id}`) }
                  : null,
              chain,
              history: parseJson(a.history_json, []),
              from: parseJson(a.from_json, {}),
              to: parseJson(a.to_json, {}),
              summary: describeChange(a),
              reason: a.reason,
              remarks: a.remarks,
              batch_id: a.batch_id,
              letter_id: a.letter_id ? Number(a.letter_id) : null,
              letter_ref: a.letter_id ? letterMap.get(Number(a.letter_id))?.ref_no || null : null,
              created_by_name: userMap.get(Number(a.created_by))?.name || null,
              created_at: a.created_at
            };
          })
      );
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/hr-ops/actions/:id/cancel", ...gate, async (req: any, res: any) => {
    try {
      const rows: any[] = await queryDB("SELECT * FROM hr_actions WHERE id = ?", [Number(req.params.id)]);
      const a = rows[0];
      if (!a) throw bad("Not found.", 404);
      if (a.status !== "pending") throw bad("Only a pending action can be cancelled.");
      const history = parseJson(a.history_json, []);
      history.push({ action: "cancelled", by: req.user.id, by_name: req.user.name, at: new Date().toISOString(), remarks: req.body?.remarks || null });
      await queryDB("UPDATE hr_actions SET status = ?, history_json = ? WHERE id = ?", ["cancelled", JSON.stringify(history), a.id]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Approve / reject — any current-step approver, or a Superadmin. Open to
  // every signed-in account (an MD may have no Admin Panel access at all);
  // reached from Approve Application.
  app.post("/api/hr-ops/actions/:id/decision", authenticateToken, async (req: any, res: any) => {
    try {
      // `action` is what Approve Application sends for every source type.
      const decision = req.body?.decision ?? req.body?.action;
      if (decision !== "approved" && decision !== "rejected") throw bad("decision must be 'approved' or 'rejected'.");
      const remarks = typeof req.body?.remarks === "string" ? req.body.remarks.trim().slice(0, 1000) || null : null;
      const rows: any[] = await queryDB("SELECT * FROM hr_actions WHERE id = ?", [Number(req.params.id)]);
      const a = rows[0];
      if (!a) throw bad("Not found.", 404);
      if (a.status !== "pending") throw bad(`This action is already ${a.status}.`);
      const chain = parseJson(a.chain_json, []);
      const step = chain.find((s: any) => Number(s.step_order) === Number(a.current_step));
      const allowed = req.user.role === "superadmin" || (step?.approver_ids || []).map(Number).includes(Number(req.user.id));
      if (!allowed) throw bad("This action isn't waiting on you.", 403);
      if (decision === "rejected" && !remarks) throw bad("Please write why you are rejecting it.");
      const history = parseJson(a.history_json, []);
      history.push({ action: decision, step: Number(a.current_step), step_label: step?.label || null, by: req.user.id, by_name: req.user.name, at: new Date().toISOString(), remarks });
      const emps: any[] = await queryDB("SELECT * FROM all_employees");
      const empName = emps.find((e: any) => Number(e.id) === Number(a.employee_id))?.name;
      let status = "pending";
      let nextStep = Number(a.current_step);
      if (decision === "rejected") status = "rejected";
      else if (Number(a.current_step) >= Number(a.total_steps)) status = "approved";
      else nextStep += 1;
      await queryDB("UPDATE hr_actions SET status = ?, current_step = ?, history_json = ?, decided_at = ? WHERE id = ?", [
        status,
        nextStep,
        JSON.stringify(history),
        status === "pending" ? null : new Date(),
        a.id
      ]);
      const fresh = { ...a, status, current_step: nextStep };
      if (status === "approved") await onActionApproved(queryDB, fresh, req.user.id, todayInDhaka());
      if (status === "pending") {
        const next = chain.find((s: any) => Number(s.step_order) === nextStep);
        for (const uid of next?.approver_ids || []) {
          await createAlert(queryDB, {
            userId: Number(uid),
            type: "hr_action",
            title: `${ACTION_LABEL.get(a.action_type)} Awaiting Your Approval`,
            message: `${req.user.name} approved — ${describeChange(a, empName)}`,
            relatedType: "hr_action",
            relatedId: Number(a.id)
          });
        }
      } else if (a.created_by) {
        await createAlert(queryDB, {
          userId: Number(a.created_by),
          type: "hr_action",
          title: `${ACTION_LABEL.get(a.action_type)} ${status === "approved" ? "Approved" : "Rejected"}`,
          message: `${describeChange(a, empName)} — ${status} by ${req.user.name}${remarks ? `: ${remarks}` : ""}`,
          relatedType: "hr_action",
          relatedId: Number(a.id)
        });
      }
      res.json({ success: true, status, current_step: nextStep });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- service book ----------------
  const serviceBook = (employeeId: number, forEmployee: boolean) => buildServiceBook(queryDB, todayInDhaka(), employeeId, forEmployee);

  app.get("/api/hr-ops/service-book/:employeeId", ...gate, async (req: any, res: any) => {
    try {
      res.json(await serviceBook(Number(req.params.employeeId), false));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- letter templates ----------------
  app.get("/api/hr-ops/letter-templates", ...gate, async (_req: any, res: any) => {
    try {
      const rows: any[] = await queryDB("SELECT * FROM hr_letter_templates");
      res.json(rows.sort((a: any, b: any) => String(a.letter_type).localeCompare(String(b.letter_type)) || Number(b.is_default) - Number(a.is_default) || Number(a.id) - Number(b.id)));
    } catch (err) {
      fail(res, err);
    }
  });

  const cleanTemplate = (body: any) => {
    const letter_type = String(body.letter_type || "");
    if (!LETTER_LABEL.has(letter_type)) throw bad("Pick a letter type.");
    const name = String(body.name || "").trim().slice(0, 150);
    const subject = String(body.subject || "").trim().slice(0, 255);
    const text = String(body.body || "").trim();
    if (!name || !subject || !text) throw bad("Name, subject and body are required.");
    return { letter_type, name, subject, body: text, is_default: body.is_default ? 1 : 0, is_active: body.is_active === false ? 0 : 1 };
  };
  // Only one default per letter type.
  const clearOtherDefaults = async (letterType: string, keepId: number) => {
    const rows: any[] = await queryDB("SELECT * FROM hr_letter_templates");
    for (const r of rows.filter((r: any) => r.letter_type === letterType && Number(r.id) !== keepId && Number(r.is_default))) {
      await queryDB("UPDATE hr_letter_templates SET is_default = ? WHERE id = ?", [0, r.id]);
    }
  };

  app.post("/api/hr-ops/letter-templates", ...gate, async (req: any, res: any) => {
    try {
      const t = cleanTemplate(req.body || {});
      const r = await queryDB(
        "INSERT INTO hr_letter_templates (letter_type, name, subject, body, is_default, is_active, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [t.letter_type, t.name, t.subject, t.body, t.is_default, t.is_active, req.user.id, req.user.id]
      );
      if (t.is_default) await clearOtherDefaults(t.letter_type, Number(r.insertId));
      res.json({ success: true, id: Number(r.insertId) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/hr-ops/letter-templates/:id", ...gate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const t = cleanTemplate(req.body || {});
      await queryDB("UPDATE hr_letter_templates SET letter_type = ?, name = ?, subject = ?, body = ?, is_default = ?, is_active = ?, updated_by = ? WHERE id = ?", [
        t.letter_type,
        t.name,
        t.subject,
        t.body,
        t.is_default,
        t.is_active,
        req.user.id,
        id
      ]);
      if (t.is_default) await clearOtherDefaults(t.letter_type, id);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/hr-ops/letter-templates/:id", ...gate, async (req: any, res: any) => {
    try {
      await queryDB("DELETE FROM hr_letter_templates WHERE id = ?", [Number(req.params.id)]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- letters ----------------
  async function pickTemplate(letterType: string, templateId?: any) {
    const rows: any[] = await queryDB("SELECT * FROM hr_letter_templates");
    if (templateId) {
      const t = rows.find((r: any) => Number(r.id) === Number(templateId));
      if (!t) throw bad("Template not found.");
      return t;
    }
    const list = rows.filter((r: any) => r.letter_type === letterType && Number(r.is_active) !== 0);
    const t = list.find((r: any) => Number(r.is_default)) || list[0];
    if (!t) throw bad("No template exists for this letter type yet — add one under Settings → Letter Templates.");
    return t;
  }

  async function renderLetter(body: any) {
    const empId = Number(body.employee_id);
    let action: any = null;
    if (body.hr_action_id) {
      const rows: any[] = await queryDB("SELECT * FROM hr_actions WHERE id = ?", [Number(body.hr_action_id)]);
      action = rows[0] || null;
      if (!action) throw bad("HR action not found.");
    }
    const letterType = String(body.letter_type || (action ? HR_ACTION_TYPES.find((t) => t.key === action.action_type)?.letter : "") || "general");
    const template = await pickTemplate(letterType, body.template_id);
    const letterDate = toDate(body.letter_date) || todayInDhaka();
    const map = await buildPlaceholders(queryDB, empId, { action, letterDate, extra: body.extra || {} });
    return {
      letter_type: template.letter_type,
      template_id: Number(template.id),
      letter_date: letterDate,
      subject: renderTemplate(body.subject_override ?? template.subject, map),
      body: renderTemplate(body.body_override ?? template.body, map),
      action
    };
  }

  app.post("/api/hr-ops/letters/preview", ...gate, async (req: any, res: any) => {
    try {
      const r = await renderLetter(req.body || {});
      const settings = await loadSettings(queryDB);
      res.json({ ...r, action: undefined, ref_no: await nextRefNo(queryDB, settings, r.letter_type, r.letter_date) });
    } catch (err) {
      fail(res, err);
    }
  });

  async function issueLetter(body: any, actor: { id: number; name: string }, requestId: number | null) {
    const r = await renderLetter(body);
    const settings = await loadSettings(queryDB);
    // An HR-edited preview wins over the template text.
    const subject = String(body.subject ?? r.subject).trim().slice(0, 255);
    const text = String(body.body ?? r.body).trim();
    if (!subject || !text) throw bad("Subject and body can't be empty.");
    const ref = await nextRefNo(queryDB, settings, r.letter_type, r.letter_date);
    const ins = await queryDB(
      `INSERT INTO hr_letters (ref_no, employee_id, letter_type, template_id, subject, body, letter_date, hr_action_id, request_id, issued_by, status, requires_ack)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ref, Number(body.employee_id), r.letter_type, r.template_id, subject, text, r.letter_date, r.action ? Number(r.action.id) : null, requestId, actor.id, "issued", body.requires_ack === false ? 0 : 1]
    );
    const letterId = Number(ins.insertId);
    if (r.action) await queryDB("UPDATE hr_actions SET letter_id = ? WHERE id = ?", [letterId, r.action.id]);
    const emps: any[] = await queryDB("SELECT * FROM all_employees");
    const emp = emps.find((e: any) => Number(e.id) === Number(body.employee_id));
    if (emp?.user_id) {
      await createAlert(queryDB, {
        userId: Number(emp.user_id),
        type: "hr_letter",
        title: `New Letter: ${LETTER_LABEL.get(r.letter_type) || "Letter"}`,
        message: `${ref} — ${subject}. Open My Letters to read${body.requires_ack === false ? "" : " and acknowledge"} it.`,
        relatedType: "hr_letter",
        relatedId: letterId
      });
    }
    return { id: letterId, ref_no: ref };
  }

  app.post("/api/hr-ops/letters", ...gate, async (req: any, res: any) => {
    try {
      res.json({ success: true, ...(await issueLetter(req.body || {}, req.user, null)) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/hr-ops/letters", ...gate, async (_req: any, res: any) => {
    try {
      const [letters, employees, users] = await Promise.all([
        queryDB("SELECT * FROM hr_letters"),
        queryDB("SELECT * FROM all_employees"),
        queryDB("SELECT * FROM users")
      ]);
      const empMap = new Map<number, any>(employees.map((e: any) => [Number(e.id), e]));
      res.json(
        letters
          .sort((a: any, b: any) => Number(b.id) - Number(a.id))
          .map((l: any) => ({
            ...l,
            id: Number(l.id),
            letter_date: toDate(l.letter_date),
            letter_label: LETTER_LABEL.get(l.letter_type) || l.letter_type,
            employee_name: empMap.get(Number(l.employee_id))?.name || "(removed)",
            employee_code: empMap.get(Number(l.employee_id))?.employee_id || null,
            designation: empMap.get(Number(l.employee_id))?.designation || null,
            issued_by_name: users.find((u: any) => Number(u.id) === Number(l.issued_by))?.name || null
          }))
      );
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/hr-ops/letters/:id/cancel", ...gate, async (req: any, res: any) => {
    try {
      const reason = String(req.body?.reason || "").trim();
      if (!reason) throw bad("Write why the letter is being cancelled.");
      await queryDB("UPDATE hr_letters SET status = ?, cancelled_reason = ? WHERE id = ?", ["cancelled", reason.slice(0, 500), Number(req.params.id)]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- certificate requests ----------------
  app.get("/api/hr-ops/letter-requests", ...gate, async (_req: any, res: any) => {
    try {
      const [rows, employees] = await Promise.all([queryDB("SELECT * FROM hr_letter_requests"), queryDB("SELECT * FROM all_employees")]);
      res.json(
        rows
          .sort((a: any, b: any) => Number(b.id) - Number(a.id))
          .map((r: any) => {
            const e = employees.find((x: any) => Number(x.id) === Number(r.employee_id));
            return { ...r, letter_label: LETTER_LABEL.get(r.letter_type) || r.letter_type, employee_name: e?.name || null, employee_code: e?.employee_id || null, designation: e?.designation || null };
          })
      );
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/hr-ops/letter-requests/:id/decision", ...gate, async (req: any, res: any) => {
    try {
      const rows: any[] = await queryDB("SELECT * FROM hr_letter_requests WHERE id = ?", [Number(req.params.id)]);
      const r = rows[0];
      if (!r) throw bad("Request not found.", 404);
      if (r.status !== "pending") throw bad("This request was already handled.");
      const decision = req.body?.decision;
      if (decision === "rejected") {
        const remarks = String(req.body?.remarks || "").trim();
        if (!remarks) throw bad("Write why the request is being rejected.");
        await queryDB("UPDATE hr_letter_requests SET status = ?, handled_by = ?, handled_at = ?, remarks = ? WHERE id = ?", ["rejected", req.user.id, new Date(), remarks.slice(0, 500), r.id]);
        await createAlert(queryDB, {
          userId: Number(r.user_id),
          type: "hr_letter",
          title: `${LETTER_LABEL.get(r.letter_type)} Request Rejected`,
          message: remarks,
          relatedType: "hr_letter_request",
          relatedId: Number(r.id)
        });
        return res.json({ success: true });
      }
      const issued = await issueLetter(
        { ...(req.body || {}), employee_id: r.employee_id, letter_type: r.letter_type, extra: { purpose: r.purpose, ...(req.body?.extra || {}) }, requires_ack: false },
        req.user,
        Number(r.id)
      );
      await queryDB("UPDATE hr_letter_requests SET status = ?, letter_id = ?, handled_by = ?, handled_at = ? WHERE id = ?", ["issued", issued.id, req.user.id, new Date(), r.id]);
      res.json({ success: true, ...issued });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- self service ----------------
  app.get("/api/hr-ops/my/letters", authenticateToken, async (req: any, res: any) => {
    try {
      const emp = await employeeForUser(req.user.id);
      if (!emp) return res.json({ letters: [], requests: [] });
      const [letters, requests] = await Promise.all([queryDB("SELECT * FROM hr_letters"), queryDB("SELECT * FROM hr_letter_requests")]);
      const settings = await loadSettings(queryDB);
      res.json({
        company: { name: settings.company_name, address: settings.company_address, signatory_name: settings.signatory_name, signatory_designation: settings.signatory_designation },
        employee: { id: Number(emp.id), name: emp.name, employee_code: emp.employee_id, designation: emp.designation, department: emp.department },
        letters: letters
          .filter((l: any) => Number(l.employee_id) === Number(emp.id) && l.status === "issued")
          .sort((a: any, b: any) => Number(b.id) - Number(a.id))
          .map((l: any) => ({ ...l, id: Number(l.id), letter_date: toDate(l.letter_date), letter_label: LETTER_LABEL.get(l.letter_type) || l.letter_type })),
        requests: requests
          .filter((r: any) => Number(r.employee_id) === Number(emp.id))
          .sort((a: any, b: any) => Number(b.id) - Number(a.id))
          .map((r: any) => ({ ...r, letter_label: LETTER_LABEL.get(r.letter_type) || r.letter_type })),
        requestable: LETTER_TYPES.filter((l) => SELF_REQUESTABLE.has(l.key))
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/hr-ops/my/letters/:id/acknowledge", authenticateToken, async (req: any, res: any) => {
    try {
      const emp = await employeeForUser(req.user.id);
      const rows: any[] = await queryDB("SELECT * FROM hr_letters WHERE id = ?", [Number(req.params.id)]);
      const l = rows[0];
      if (!l || !emp || Number(l.employee_id) !== Number(emp.id)) throw bad("Letter not found.", 404);
      if (l.acknowledged_at) return res.json({ success: true });
      await queryDB("UPDATE hr_letters SET acknowledged_at = ?, ack_note = ? WHERE id = ?", [new Date(), req.body?.note ? String(req.body.note).slice(0, 500) : null, l.id]);
      if (l.issued_by) {
        await createAlert(queryDB, {
          userId: Number(l.issued_by),
          type: "hr_letter",
          title: "Letter Acknowledged",
          message: `${emp.name} acknowledged ${l.ref_no} — ${l.subject}`,
          relatedType: "hr_letter",
          relatedId: Number(l.id)
        });
      }
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/hr-ops/my/letter-requests", authenticateToken, async (req: any, res: any) => {
    try {
      const emp = await employeeForUser(req.user.id);
      if (!emp) throw bad("Your login isn't linked to an Employee record yet — please contact HR.");
      const type = String(req.body?.letter_type || "");
      if (!SELF_REQUESTABLE.has(type)) throw bad("This letter can't be requested.");
      const purpose = String(req.body?.purpose || "").trim().slice(0, 500);
      if (!purpose) throw bad("Write what you need it for.");
      const existing: any[] = await queryDB("SELECT * FROM hr_letter_requests");
      if (existing.some((r: any) => Number(r.employee_id) === Number(emp.id) && r.letter_type === type && r.status === "pending")) {
        throw bad("You already have a pending request for this letter.");
      }
      const r = await queryDB("INSERT INTO hr_letter_requests (employee_id, user_id, letter_type, purpose, status) VALUES (?, ?, ?, ?, ?)", [
        emp.id,
        req.user.id,
        type,
        purpose,
        "pending"
      ]);
      for (const uid of await hrOperators()) {
        await createAlert(queryDB, {
          userId: uid,
          type: "hr_letter",
          title: `${LETTER_LABEL.get(type)} Requested`,
          message: `${emp.name} requested a ${LETTER_LABEL.get(type)} — ${purpose}`,
          relatedType: "hr_letter_request",
          relatedId: Number(r.insertId)
        });
      }
      res.json({ success: true, id: Number(r.insertId) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/hr-ops/my/service-book", authenticateToken, async (req: any, res: any) => {
    try {
      const emp = await employeeForUser(req.user.id);
      if (!emp) return res.json({ employee: null, events: [] });
      res.json(await serviceBook(Number(emp.id), true));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- onboarding ----------------
  app.get("/api/hr-ops/onboarding-tasks", ...gate, async (_req: any, res: any) => {
    try {
      const rows: any[] = await queryDB("SELECT * FROM hr_onboarding_tasks");
      res.json(rows.sort((a: any, b: any) => Number(a.sort_order) - Number(b.sort_order)));
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/hr-ops/onboarding-tasks", ...gate, async (req: any, res: any) => {
    try {
      const list = Array.isArray(req.body?.tasks) ? req.body.tasks : null;
      if (!list) throw bad("tasks must be an array.");
      const rows: any[] = await queryDB("SELECT * FROM hr_onboarding_tasks");
      const keep = new Set<number>();
      let order = 0;
      for (const t of list) {
        const label = String(t.label || "").trim().slice(0, 200);
        if (!label) continue;
        const values = [label, String(t.category || "Other").slice(0, 60), Math.round(Number(t.due_days) || 0), ++order, t.is_active === false ? 0 : 1];
        if (t.id && rows.some((r: any) => Number(r.id) === Number(t.id))) {
          await queryDB("UPDATE hr_onboarding_tasks SET label = ?, category = ?, due_days = ?, sort_order = ?, is_active = ? WHERE id = ?", [...values, Number(t.id)]);
          keep.add(Number(t.id));
        } else {
          const key = String(t.task_key || "custom_" + Date.now() + "_" + order).slice(0, 60);
          const r = await queryDB("INSERT INTO hr_onboarding_tasks (task_key, label, category, due_days, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?)", [key, ...values]);
          keep.add(Number(r.insertId));
        }
      }
      for (const r of rows.filter((r: any) => !keep.has(Number(r.id)))) await queryDB("DELETE FROM hr_onboarding_tasks WHERE id = ?", [r.id]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Ticks items whose fact already exists elsewhere in the app.
  async function autoDetect(employeeId: number, items: any[]) {
    const [emps, supervisors, letters, accounts, services, assignments] = await Promise.all([
      queryDB("SELECT * FROM all_employees"),
      queryDB("SELECT * FROM employee_supervisors").catch(() => []),
      queryDB("SELECT * FROM hr_letters"),
      queryDB("SELECT * FROM employee_payment_accounts").catch(() => []),
      queryDB("SELECT * FROM hr_employee_service"),
      queryDB("SELECT * FROM asset_assignments").catch(() => [])
    ]);
    const e = emps.find((x: any) => Number(x.id) === employeeId);
    if (!e) return;
    const svc = services.find((s: any) => Number(s.employee_id) === employeeId);
    const hasLetter = (type: string) => letters.some((l: any) => Number(l.employee_id) === employeeId && l.letter_type === type && l.status === "issued");
    const bank = accounts.find((a: any) => Number(a.employee_id) === employeeId && a.account_type === "bank" && Number(a.is_active) !== 0);
    const detect: Record<string, string | null> = {
      appointment_letter: hasLetter("appointment") ? "Appointment letter issued" : null,
      bank_letter: hasLetter("bank_account") ? "Bank letter issued" : null,
      bank_account: bank ? `${bank.bank_name || "Bank"} — ${bank.account_number}` : null,
      login_account: e.user_id ? "Login exists" : null,
      device_pin: e.zk_device_pin ? `PIN ${e.zk_device_pin}` : null,
      supervisor: supervisors.some((s: any) => Number(s.employee_id) === employeeId && Number(s.is_direct) === 1) ? "Direct supervisor set" : null,
      probation_set: svc?.probation_end_date ? `Until ${toDate(svc.probation_end_date)}` : null,
      asset_handover: e.user_id && assignments.some((a: any) => Number(a.user_id ?? a.assigned_to) === Number(e.user_id)) ? "Asset assigned" : null
    };
    for (const it of items) {
      const found = detect[it.task_key];
      if (found && it.status === "pending") {
        await queryDB("UPDATE hr_onboarding_items SET status = ?, note = ?, value_text = ?, done_at = ? WHERE id = ?", ["done", "Auto-detected", found.slice(0, 255), new Date(), it.id]);
        it.status = "done";
        it.note = "Auto-detected";
        it.value_text = found;
      }
    }
  }

  app.get("/api/hr-ops/onboarding", ...gate, async (_req: any, res: any) => {
    try {
      const [emps, items] = await Promise.all([queryDB("SELECT * FROM all_employees"), queryDB("SELECT id, employee_id, status, due_date FROM hr_onboarding_items")]);
      const today = todayInDhaka();
      const since = addDays(today, -120);
      const out = emps
        .filter((e: any) => items.some((i: any) => Number(i.employee_id) === Number(e.id)) || ((toDate(e.joining_date) || "") >= since && Number(e.is_active ?? 1) !== 0))
        .map((e: any) => {
          const mine = items.filter((i: any) => Number(i.employee_id) === Number(e.id));
          const done = mine.filter((i: any) => i.status !== "pending").length;
          return {
            employee_id: Number(e.id),
            name: e.name,
            employee_code: e.employee_id,
            designation: e.designation,
            department: e.department,
            joining_date: toDate(e.joining_date),
            started: mine.length > 0,
            total: mine.length,
            done,
            overdue: mine.filter((i: any) => i.status === "pending" && i.due_date && toDate(i.due_date)! < today).length
          };
        })
        .sort((a: any, b: any) => (b.joining_date || "").localeCompare(a.joining_date || ""));
      res.json(out);
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/hr-ops/onboarding/:employeeId/start", ...gate, async (req: any, res: any) => {
    try {
      const empId = Number(req.params.employeeId);
      const [emps, tasks, items] = await Promise.all([queryDB("SELECT * FROM all_employees"), queryDB("SELECT * FROM hr_onboarding_tasks"), queryDB("SELECT * FROM hr_onboarding_items")]);
      const e = emps.find((x: any) => Number(x.id) === empId);
      if (!e) throw bad("Employee not found.", 404);
      const base = toDate(e.joining_date) || todayInDhaka();
      const have = new Set(items.filter((i: any) => Number(i.employee_id) === empId).map((i: any) => i.task_key));
      let added = 0;
      for (const t of tasks.filter((t: any) => Number(t.is_active) !== 0).sort((a: any, b: any) => Number(a.sort_order) - Number(b.sort_order))) {
        if (have.has(t.task_key)) continue;
        await queryDB("INSERT INTO hr_onboarding_items (employee_id, task_key, label, category, sort_order, status, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)", [
          empId,
          t.task_key,
          t.label,
          t.category,
          Number(t.sort_order),
          "pending",
          addDays(base, Number(t.due_days) || 0)
        ]);
        added++;
      }
      // Default probation for a brand-new Employee with none set yet.
      const services: any[] = await queryDB("SELECT * FROM hr_employee_service");
      if (!services.some((s: any) => Number(s.employee_id) === empId) && toDate(e.joining_date)) {
        const settings = await loadSettings(queryDB);
        const months = Number(settings.default_probation_months || 6);
        await upsertService(queryDB, empId, { probation_months: months, probation_end_date: addMonths(toDate(e.joining_date)!, months), service_status: "probation" }, req.user.id);
      }
      res.json({ success: true, added });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/hr-ops/onboarding/:employeeId", ...gate, async (req: any, res: any) => {
    try {
      const empId = Number(req.params.employeeId);
      const [rows, users] = await Promise.all([
        queryDB("SELECT id, employee_id, task_key, label, category, sort_order, status, due_date, note, value_text, attachment_name, done_by, done_at FROM hr_onboarding_items"),
        queryDB("SELECT * FROM users")
      ]);
      const items = rows.filter((i: any) => Number(i.employee_id) === empId).sort((a: any, b: any) => Number(a.sort_order) - Number(b.sort_order));
      await autoDetect(empId, items);
      res.json(
        items.map((i: any) => ({
          ...i,
          due_date: toDate(i.due_date),
          done_by_name: users.find((u: any) => Number(u.id) === Number(i.done_by))?.name || null,
          has_attachment: !!i.attachment_name
        }))
      );
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/hr-ops/onboarding/items/:id", ...gate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const rows: any[] = await queryDB("SELECT * FROM hr_onboarding_items WHERE id = ?", [id]);
      const it = rows[0];
      if (!it) throw bad("Item not found.", 404);
      const body = req.body || {};
      const status = ["pending", "done", "na"].includes(body.status) ? body.status : it.status;
      await queryDB("UPDATE hr_onboarding_items SET status = ?, note = ?, value_text = ?, due_date = ?, done_by = ?, done_at = ? WHERE id = ?", [
        status,
        body.note !== undefined ? String(body.note || "").slice(0, 500) || null : it.note,
        body.value_text !== undefined ? String(body.value_text || "").slice(0, 255) || null : it.value_text,
        body.due_date !== undefined ? toDate(body.due_date) : toDate(it.due_date),
        status === "pending" ? null : req.user.id,
        status === "pending" ? null : new Date(),
        id
      ]);
      if (body.attachment_base64 && body.attachment_name) {
        const buf = Buffer.from(String(body.attachment_base64), "base64");
        if (buf.length > 8 * 1024 * 1024) throw bad("Attachment is larger than 8 MB.");
        await queryDB("UPDATE hr_onboarding_items SET attachment_name = ?, attachment_mime = ?, attachment_data = ? WHERE id = ?", [
          String(body.attachment_name).slice(0, 255),
          String(body.attachment_mime || "application/octet-stream").slice(0, 100),
          buf,
          id
        ]);
      }
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/hr-ops/onboarding/items/:id/attachment", ...gate, async (req: any, res: any) => {
    try {
      const rows: any[] = await queryDB("SELECT * FROM hr_onboarding_items WHERE id = ?", [Number(req.params.id)]);
      const it = rows[0];
      if (!it?.attachment_data) throw bad("No attachment.", 404);
      const buf: Buffer = Buffer.isBuffer(it.attachment_data) ? it.attachment_data : Buffer.from(it.attachment_data);
      res.setHeader("Content-Type", it.attachment_mime || "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(it.attachment_name || "attachment")}"`);
      res.send(buf);
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- increment policies ----------------
  app.get("/api/hr-ops/increment-policies", ...gate, async (_req: any, res: any) => {
    try {
      const rows: any[] = await queryDB("SELECT * FROM hr_increment_policies");
      res.json(rows.sort((a: any, b: any) => Number(a.id) - Number(b.id)));
    } catch (err) {
      fail(res, err);
    }
  });

  const cleanPolicy = (b: any) => {
    const name = String(b.name || "").trim().slice(0, 150);
    if (!name) throw bad("Give the rule a name.");
    const basis = b.basis === "fixed_month" ? "fixed_month" : "anniversary";
    const fixed = basis === "fixed_month" ? Math.min(12, Math.max(1, Math.round(Number(b.fixed_month) || 1))) : null;
    return [
      name,
      basis,
      fixed,
      Math.max(0, Math.round(Number(b.min_service_months ?? 12))),
      Math.max(0, Number(b.default_percent ?? 5)),
      num(b.department_id),
      b.grade ? String(b.grade).slice(0, 100) : null,
      b.job_base ? String(b.job_base).slice(0, 50) : null,
      b.is_active === false ? 0 : 1
    ];
  };
  app.post("/api/hr-ops/increment-policies", ...gate, async (req: any, res: any) => {
    try {
      const v = cleanPolicy(req.body || {});
      const r = await queryDB(
        "INSERT INTO hr_increment_policies (name, basis, fixed_month, min_service_months, default_percent, department_id, grade, job_base, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [...v, req.user.id]
      );
      res.json({ success: true, id: Number(r.insertId) });
    } catch (err) {
      fail(res, err);
    }
  });
  app.put("/api/hr-ops/increment-policies/:id", ...gate, async (req: any, res: any) => {
    try {
      const v = cleanPolicy(req.body || {});
      await queryDB(
        "UPDATE hr_increment_policies SET name = ?, basis = ?, fixed_month = ?, min_service_months = ?, default_percent = ?, department_id = ?, grade = ?, job_base = ?, is_active = ? WHERE id = ?",
        [...v, Number(req.params.id)]
      );
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });
  app.delete("/api/hr-ops/increment-policies/:id", ...gate, async (req: any, res: any) => {
    try {
      await queryDB("DELETE FROM hr_increment_policies WHERE id = ?", [Number(req.params.id)]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Who a rule applies to in the window [from, to] (defaults: this month
  // through the next two), with their last increment and a suggestion.
  app.get("/api/hr-ops/increments/due", ...gate, async (req: any, res: any) => {
    try {
      await sweep();
      const policies: any[] = await queryDB("SELECT * FROM hr_increment_policies");
      const policy = policies.find((p: any) => Number(p.id) === Number(req.query.policy_id)) || policies.find((p: any) => Number(p.is_active));
      if (!policy) return res.json({ policy: null, rows: [] });
      const today = todayInDhaka();
      const winFrom = toDate(req.query.from) || today.slice(0, 8) + "01";
      const winTo = toDate(req.query.to) || addDays(addMonths(winFrom, 3), -1);
      const world = await loadEmployeeWorld(queryDB);
      const actions: any[] = await queryDB("SELECT * FROM hr_actions");
      const rows: any[] = [];
      for (const e of world.employees) {
        if (Number(e.is_active ?? 1) === 0) continue;
        const snap = snapshotOf(world, Number(e.id))!;
        const cur = currentValues(snap);
        if (policy.department_id && Number(policy.department_id) !== Number(cur.department_id)) continue;
        if (policy.grade && String(policy.grade) !== String(cur.grade || "")) continue;
        if (policy.job_base && String(policy.job_base) !== String(e.job_base || "")) continue;
        const joining = toDate(e.joining_date);
        if (!joining) continue;
        const salaries = world.salaries
          .filter((s: any) => Number(s.employee_id) === Number(e.id))
          .sort((a: any, b: any) => (toDate(a.effective_date) || "").localeCompare(toDate(b.effective_date) || ""));
        let lastIncrement: string | null = null;
        for (let i = 1; i < salaries.length; i++) {
          if (Number(salaries[i].gross_salary) > Number(salaries[i - 1].gross_salary)) lastIncrement = toDate(salaries[i].effective_date);
        }
        const pending = actions.find(
          (a: any) => Number(a.employee_id) === Number(e.id) && (a.action_type === "increment" || a.action_type === "salary_adjustment") && a.status === "pending"
        );
        let due: string;
        if (policy.basis === "fixed_month") {
          const fm = String(policy.fixed_month).padStart(2, "0");
          due = `${winFrom.slice(0, 4)}-${fm}-01`;
          if (due < winFrom) due = `${Number(winFrom.slice(0, 4)) + 1}-${fm}-01`;
        } else {
          const base = lastIncrement || joining;
          due = addMonths(base, 12);
          while (due < winFrom && monthsBetween(due, winFrom) >= 12) due = addMonths(due, 12);
        }
        if (due > winTo) continue;
        if (monthsBetween(joining, due) < Number(policy.min_service_months || 0)) continue;
        if (lastIncrement && monthsBetween(lastIncrement, due) < 11) continue;
        const pct = Number(policy.default_percent || 0);
        const gross = cur.gross_salary;
        rows.push({
          employee_id: Number(e.id),
          name: e.name,
          employee_code: e.employee_id,
          designation: e.designation,
          department: e.department,
          grade: cur.grade,
          joining_date: joining,
          last_increment: lastIncrement,
          due_date: due,
          overdue: due < today,
          current_gross: gross,
          percent: pct,
          new_gross: gross ? Math.round(gross * (1 + pct / 100)) : null,
          pending_action_id: pending ? Number(pending.id) : null
        });
      }
      rows.sort((a, b) => a.due_date.localeCompare(b.due_date) || String(a.name).localeCompare(String(b.name)));
      res.json({ policy, from: winFrom, to: winTo, rows });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- monthly report ----------------
  const DIMENSIONS: Record<string, (e: any, snap: EmployeeSnapshot) => string> = {
    department: (e) => e.department || "No Department",
    branch: (e) => e.branch || "No Branch",
    designation: (e) => e.designation || "No Designation",
    grade: (_e, s) => s.service?.grade || "No Grade",
    project: (_e, s) => s.project?.name || "No Project",
    employment_category: (e) => e.employment_category || "Not set",
    job_base: (e) => e.job_base || "Not set",
    division: (e) => e.division || "Not set",
    unit: (e) => e.unit || "Not set",
    gender: (e) => e.gender || "Not set"
  };

  app.get("/api/hr-ops/reports/monthly", ...gate, async (req: any, res: any) => {
    try {
      await sweep();
      const today = todayInDhaka();
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : today.slice(0, 7);
      const groupBy = DIMENSIONS[String(req.query.group_by)] ? String(req.query.group_by) : "department";
      const filterDim = DIMENSIONS[String(req.query.filter_by)] ? String(req.query.filter_by) : null;
      const filterVal = req.query.filter_value ? String(req.query.filter_value) : null;
      const mStart = `${month}-01`;
      const mEnd = addDays(addMonths(mStart, 1), -1);
      const world = await loadEmployeeWorld(queryDB);
      const [actions, transfers, exits, letters, requests] = await Promise.all([
        queryDB("SELECT * FROM hr_actions"),
        queryDB("SELECT * FROM employee_transfers").catch(() => []),
        queryDB("SELECT * FROM exit_requests").catch(() => []),
        queryDB("SELECT * FROM hr_letters"),
        queryDB("SELECT * FROM hr_letter_requests")
      ]);
      const snaps = new Map<number, EmployeeSnapshot>();
      for (const e of world.employees) snaps.set(Number(e.id), snapshotOf(world, Number(e.id))!);
      const dimOf = (dim: string, empId: number) => {
        const s = snaps.get(empId);
        return s ? DIMENSIONS[dim](s.employee, s) : "—";
      };
      const inScope = (empId: number) => !filterDim || !filterVal || dimOf(filterDim, empId) === filterVal;
      const empName = (id: number) => snaps.get(id)?.employee.name || "(removed)";
      const empCode = (id: number) => snaps.get(id)?.employee.employee_id || null;

      // Exit date per Employee: approved separation action or exit request.
      const exitDate = new Map<number, string>();
      for (const a of actions.filter((a: any) => SEPARATION_TYPES.has(a.action_type) && a.status === "approved")) {
        const d = toDate(a.effective_date)!;
        const k = Number(a.employee_id);
        if (!exitDate.has(k) || d < exitDate.get(k)!) exitDate.set(k, d);
      }
      const empByUser = new Map<number, number>(world.employees.filter((e: any) => e.user_id).map((e: any) => [Number(e.user_id), Number(e.id)]));
      for (const x of exits.filter((x: any) => x.status !== "cancelled" && x.last_working_day)) {
        const k = empByUser.get(Number(x.user_id));
        if (!k) continue;
        const d = toDate(x.last_working_day)!;
        if (!exitDate.has(k) || d < exitDate.get(k)!) exitDate.set(k, d);
      }
      const joinDate = (e: any) => toDate(e.joining_date) || toDate(e.created_at);
      const activeOn = (e: any, d: string) => {
        const j = joinDate(e);
        if (!j || j > d) return false;
        const x = exitDate.get(Number(e.id));
        if (x) return x >= d;
        return Number(e.is_active ?? 1) !== 0;
      };
      const scoped = world.employees.filter((e: any) => inScope(Number(e.id)));
      const inMonth = (d: string | null) => !!d && d >= mStart && d <= mEnd;

      const joined = scoped.filter((e: any) => inMonth(joinDate(e)));
      const separated = scoped.filter((e: any) => inMonth(exitDate.get(Number(e.id)) || null));
      const monthActions = actions.filter((a: any) => a.status === "approved" && inMonth(toDate(a.effective_date)) && inScope(Number(a.employee_id)));
      const ofType = (...types: string[]) => monthActions.filter((a: any) => types.includes(a.action_type));
      const actionLinkedTransfer = new Set(actions.map((a: any) => Number(a.transfer_id)).filter(Boolean));
      const monthTransfers = transfers.filter(
        (t: any) =>
          inMonth(toDate(t.effective_date)) &&
          inScope(Number(t.employee_id)) &&
          !actionLinkedTransfer.has(Number(t.id)) &&
          (t.from_department_name || "") !== (t.to_department_name || "")
      );
      // Salary revisions in the month (increments whether they came from an
      // HR action or were typed straight into Payroll).
      const revisions: any[] = [];
      for (const e of scoped) {
        const list = world.salaries
          .filter((s: any) => Number(s.employee_id) === Number(e.id))
          .sort((a: any, b: any) => (toDate(a.effective_date) || "").localeCompare(toDate(b.effective_date) || "") || Number(a.id) - Number(b.id));
        for (let i = 1; i < list.length; i++) {
          if (inMonth(toDate(list[i].effective_date)) && Number(list[i].gross_salary) !== Number(list[i - 1].gross_salary)) {
            revisions.push({
              employee_id: Number(e.id),
              name: e.name,
              employee_code: e.employee_id,
              effective_date: toDate(list[i].effective_date),
              old_gross: Number(list[i - 1].gross_salary),
              new_gross: Number(list[i].gross_salary),
              difference: Number(list[i].gross_salary) - Number(list[i - 1].gross_salary)
            });
          }
        }
      }
      const opening = scoped.filter((e: any) => activeOn(e, addDays(mStart, -1))).length;
      const closing = scoped.filter((e: any) => activeOn(e, mEnd)).length;
      const avg = (opening + closing) / 2;

      const listAction = (a: any) => ({
        id: Number(a.id),
        employee_id: Number(a.employee_id),
        name: empName(Number(a.employee_id)),
        employee_code: empCode(Number(a.employee_id)),
        effective_date: toDate(a.effective_date),
        summary: describeChange(a).replace(/^[^:]*:?\s?/, "").replace(/ \(eff\. .*\)$/, ""),
        reason: a.reason || null
      });

      // Group breakdown.
      const groups = new Map<string, any>();
      const g = (key: string) => {
        if (!groups.has(key)) groups.set(key, { key, opening: 0, closing: 0, joined: 0, separated: 0, promotions: 0, transfers: 0, increments: 0, confirmations: 0 });
        return groups.get(key);
      };
      for (const e of scoped) {
        const key = dimOf(groupBy, Number(e.id));
        if (activeOn(e, addDays(mStart, -1))) g(key).opening++;
        if (activeOn(e, mEnd)) g(key).closing++;
      }
      joined.forEach((e: any) => g(dimOf(groupBy, Number(e.id))).joined++);
      separated.forEach((e: any) => g(dimOf(groupBy, Number(e.id))).separated++);
      ofType("promotion").forEach((a: any) => g(dimOf(groupBy, Number(a.employee_id))).promotions++);
      ofType("transfer").forEach((a: any) => g(dimOf(groupBy, Number(a.employee_id))).transfers++);
      monthTransfers.forEach((t: any) => g(dimOf(groupBy, Number(t.employee_id))).transfers++);
      revisions.filter((r) => r.difference > 0).forEach((r) => g(dimOf(groupBy, r.employee_id)).increments++);
      ofType("confirmation").forEach((a: any) => g(dimOf(groupBy, Number(a.employee_id))).confirmations++);

      // Upcoming (next 60 days from the end of the month or today).
      const horizonFrom = mEnd < today ? today : mStart;
      const horizonTo = addDays(horizonFrom, 60);
      const probationEnding: any[] = [];
      const contractEnding: any[] = [];
      for (const e of scoped.filter((e: any) => activeOn(e, today) || activeOn(e, mEnd))) {
        const s = snaps.get(Number(e.id))!;
        const status = s.service?.service_status;
        const probEnd = toDate(s.service?.probation_end_date);
        if (probEnd && status !== "confirmed" && probEnd >= addDays(horizonFrom, -30) && probEnd <= horizonTo && e.job_base !== "Permanent") {
          probationEnding.push({ employee_id: Number(e.id), name: e.name, employee_code: e.employee_id, designation: e.designation, date: probEnd, overdue: probEnd < today });
        }
        const cEnd = toDate(s.service?.contract_end_date);
        if (cEnd && cEnd >= addDays(horizonFrom, -30) && cEnd <= horizonTo) {
          contractEnding.push({ employee_id: Number(e.id), name: e.name, employee_code: e.employee_id, designation: e.designation, date: cEnd, overdue: cEnd < today });
        }
      }

      // 12-month trend ending with this month.
      const trend: any[] = [];
      for (let i = 11; i >= 0; i--) {
        const ms = addMonths(mStart, -i);
        const me = addDays(addMonths(ms, 1), -1);
        const within = (d: string | null) => !!d && d >= ms && d <= me;
        trend.push({
          month: ms.slice(0, 7),
          headcount: scoped.filter((e: any) => activeOn(e, me)).length,
          joined: scoped.filter((e: any) => within(joinDate(e))).length,
          separated: scoped.filter((e: any) => within(exitDate.get(Number(e.id)) || null)).length
        });
      }

      const resignationsSubmitted = exits.filter(
        (x: any) => x.exit_type !== "termination" && x.status !== "cancelled" && inMonth(toDate(x.created_at)) && empByUser.has(Number(x.user_id)) && inScope(empByUser.get(Number(x.user_id))!)
      );

      res.json({
        month,
        group_by: groupBy,
        dimensions: Object.keys(DIMENSIONS),
        dimension_values: Object.fromEntries(
          Object.keys(DIMENSIONS).map((d) => [d, Array.from(new Set(world.employees.map((e: any) => dimOf(d, Number(e.id))))).sort()])
        ),
        summary: {
          opening,
          closing,
          joined: joined.length,
          separated: separated.length,
          resignations_submitted: resignationsSubmitted.length,
          promotions: ofType("promotion").length,
          transfers: ofType("transfer").length + monthTransfers.length,
          increments: revisions.filter((r) => r.difference > 0).length,
          increment_total: revisions.filter((r) => r.difference > 0).reduce((s, r) => s + r.difference, 0),
          confirmations: ofType("confirmation").length,
          other_actions: monthActions.filter((a: any) => !["promotion", "transfer", "confirmation", "increment", "salary_adjustment"].includes(a.action_type)).length,
          turnover_pct: avg > 0 ? Number(((separated.length / avg) * 100).toFixed(2)) : 0,
          letters_issued: letters.filter((l: any) => l.status === "issued" && inMonth(toDate(l.letter_date)) && inScope(Number(l.employee_id))).length,
          letters_unacknowledged: letters.filter((l: any) => l.status === "issued" && Number(l.requires_ack) && !l.acknowledged_at && inScope(Number(l.employee_id))).length,
          pending_actions: actions.filter((a: any) => a.status === "pending" && inScope(Number(a.employee_id))).length,
          pending_letter_requests: requests.filter((r: any) => r.status === "pending").length
        },
        lists: {
          joined: joined.map((e: any) => ({ employee_id: Number(e.id), name: e.name, employee_code: e.employee_id, designation: e.designation, department: e.department, date: joinDate(e) })),
          separated: separated.map((e: any) => {
            const act = actions.find((a: any) => Number(a.employee_id) === Number(e.id) && SEPARATION_TYPES.has(a.action_type) && a.status === "approved");
            return {
              employee_id: Number(e.id),
              name: e.name,
              employee_code: e.employee_id,
              designation: e.designation,
              department: e.department,
              date: exitDate.get(Number(e.id)),
              type: act ? ACTION_LABEL.get(act.action_type) : "Resignation"
            };
          }),
          resignations_submitted: resignationsSubmitted.map((x: any) => {
            const id = empByUser.get(Number(x.user_id))!;
            return { employee_id: id, name: empName(id), employee_code: empCode(id), date: toDate(x.created_at), last_working_day: toDate(x.last_working_day), status: x.status };
          }),
          promotions: ofType("promotion").map(listAction),
          transfers: [
            ...ofType("transfer").map(listAction),
            ...monthTransfers.map((t: any) => ({
              id: null,
              employee_id: Number(t.employee_id),
              name: empName(Number(t.employee_id)),
              employee_code: empCode(Number(t.employee_id)),
              effective_date: toDate(t.effective_date),
              summary: `${t.from_department_name || "—"} → ${t.to_department_name || "—"}`,
              reason: t.reason || null
            }))
          ],
          increments: revisions.filter((r) => r.difference > 0),
          confirmations: ofType("confirmation").map(listAction),
          other_actions: monthActions.filter((a: any) => !["promotion", "transfer", "confirmation", "increment", "salary_adjustment"].includes(a.action_type)).map((a: any) => ({ ...listAction(a), type: ACTION_LABEL.get(a.action_type) }))
        },
        groups: Array.from(groups.values()).sort((a, b) => a.key.localeCompare(b.key)),
        upcoming: {
          probation_ending: probationEnding.sort((a, b) => a.date.localeCompare(b.date)),
          contract_ending: contractEnding.sort((a, b) => a.date.localeCompare(b.date))
        },
        trend
      });
    } catch (err) {
      fail(res, err);
    }
  });
}
