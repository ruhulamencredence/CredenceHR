/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Access Templates (Admin Panel -> Users -> Access Templates) — the switches a
// template can turn on, and the "default for new logins" template that Data
// Import -> Employee Details applies to every login it creates.

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

// Feature key -> the users column(s) it turns on. The first five are the
// Manage panel's own switches (PUT /api/users/:id/feature-permissions); the
// rest are Module Access -> "Also allow …" Self Service switches, which each
// have their own endpoint and need module-grant rights.
export const TEMPLATE_FEATURE_COLUMNS: Record<string, string[]> = {
  can_use_attendance: ["can_use_attendance"],
  can_use_tracking: ["can_use_tracking"],
  can_view_leave_summary: ["can_view_leave_summary"],
  can_edit_delivery_date: ["can_edit_delivery_date"],
  can_job_edit: ["can_job_edit"],
  can_view_movement_claims: ["can_view_movement_claims"],
  can_view_bill_claims: ["can_view_bill_claims"],
  can_view_timesheet: ["can_view_timesheet"],
  // Leave Application and My Leave are one switch in Module Access.
  can_view_leave_application: ["can_view_leave_application", "can_view_my_leave"],
  can_view_tasks: ["can_view_tasks"],
  can_view_mobile_bill: ["can_view_mobile_bill"],
  can_view_service_book: ["can_view_service_book"],
  can_view_loan_request: ["can_view_loan_request"],
  can_view_targets: ["can_view_targets"],
  can_use_mail: ["can_use_mail"],
  can_view_roster: ["can_view_roster"],
  can_take_break: ["can_take_break"],
  can_save_ride_places: ["can_save_ride_places"],
  can_update_check_out: ["can_update_check_out"],
  can_add_adhoc_approver: ["can_add_adhoc_approver"],
  can_use_assistant_voice: ["can_use_assistant_voice"],
  can_sign_documents: ["can_sign_documents"],
  can_view_payslip: ["can_view_payslip"],
  can_request_items: ["can_request_items"]
};
export const TEMPLATE_FEATURES = Object.keys(TEMPLATE_FEATURE_COLUMNS);

export const DEFAULT_USER_TEMPLATE = {
  name: "Default User",
  description: "Given to every login created by Employee Details import",
  features: [
    "can_use_attendance",
    "can_use_tracking",
    "can_view_leave_summary",
    "can_view_movement_claims",
    "can_view_bill_claims",
    "can_view_timesheet",
    "can_view_leave_application",
    "can_view_tasks",
    "can_view_mobile_bill",
    "can_view_service_book"
  ],
  modules: [] as string[]
};

const parseList = (v: any): string[] => {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};

export async function ensureAccessTemplateSchema(queryDB: QueryDB) {
  // Add each column only when it's missing, so a normal restart doesn't hit
  // (and log) a "Duplicate column" error from queryDB.
  let existing = new Set<string>();
  try {
    const cols: any[] = (await queryDB("/*unscoped*/ SHOW COLUMNS FROM access_templates")) || [];
    existing = new Set(cols.map((c) => String(c.Field)));
  } catch {
    // Table check failed — fall through and let the ALTERs report it.
  }
  const addColumn = async (name: string, ddl: string) => {
    if (existing.has(name)) return;
    try {
      await queryDB(`ALTER TABLE access_templates ADD COLUMN ${name} ${ddl}`);
    } catch (err: any) {
      if (err?.code !== "ER_DUP_FIELDNAME") console.warn(`⚠️ Could not add access_templates.${name} column: ` + err.message);
    }
  };
  await addColumn("is_default", "TINYINT(1) NOT NULL DEFAULT 0");
  // One-time additions to the "Default User" template that already exists
  // in a database (features_rev counts them, so a switch HR later removes
  // from the template isn't put back): rev 1 = My Service Book.
  await addColumn("features_rev", "INT NOT NULL DEFAULT 0");
  // The whole access a template was saved with from Module Access ("Save as
  // template"): modules, their layers, every switch and the Mobile App
  // access. NULL for templates made the old way (features + modules only).
  await addColumn("access_json", "LONGTEXT NULL");
  // Rows made from now on already have every addition.
  await queryDB("ALTER TABLE access_templates ALTER COLUMN features_rev SET DEFAULT 1").catch(() => undefined);
  try {
    const rows: any[] = (await queryDB("/*unscoped*/ SELECT id, name, features_json, features_rev FROM access_templates")) || [];
    for (const r of rows) {
      if (Number(r.features_rev || 0) >= 1) continue;
      if (r.name === DEFAULT_USER_TEMPLATE.name) {
        const features = parseList(r.features_json);
        if (!features.includes("can_view_service_book")) features.push("can_view_service_book");
        await queryDB("UPDATE access_templates SET features_json = ?, features_rev = 1 WHERE id = ?", [JSON.stringify(features), r.id]);
      } else {
        await queryDB("UPDATE access_templates SET features_rev = 1 WHERE id = ?", [r.id]);
      }
    }
  } catch (err: any) {
    console.warn("⚠️ Could not update the Default User access template: " + err.message);
  }
}


// The company always has exactly one default template: "Default User" is
// created (with the permissions above) the first time none is marked.
// Called inside a request, so the rows are the active company's.
export async function ensureDefaultAccessTemplate(queryDB: QueryDB): Promise<{ id: number; name: string; features: string[]; modules: string[] }> {
  const rows: any[] = (await queryDB("SELECT * FROM access_templates").catch(() => [])) || [];
  const marked = rows.find((r) => Number(r.is_default) === 1);
  if (marked) return { id: Number(marked.id), name: marked.name, features: parseList(marked.features_json), modules: parseList(marked.modules_json) };
  const t = DEFAULT_USER_TEMPLATE;
  const r: any = await queryDB(
    "INSERT INTO access_templates (name, description, features_json, modules_json, is_default) VALUES (?, ?, ?, ?, 1)",
    [t.name, t.description, JSON.stringify(t.features), JSON.stringify(t.modules)]
  );
  return { id: Number(r.insertId), name: t.name, features: [...t.features], modules: [...t.modules] };
}

// Turns on a template's switches and adds its modules for one login (nothing
// is removed), and records it in the account's access activity.
export async function applyAccessTemplate(
  queryDB: QueryDB,
  userId: number,
  template: { name: string; features: string[]; modules: string[] },
  actorId: number | null,
  companyId: number
) {
  const cols = Array.from(new Set(template.features.flatMap((f) => TEMPLATE_FEATURE_COLUMNS[f] || [])));
  if (cols.length) await queryDB(`UPDATE users SET ${cols.map((c) => `${c} = 1`).join(", ")} WHERE id = ?`, [userId]);
  if (template.modules.length) {
    const have: any[] = (await queryDB("SELECT module_key FROM admin_module_permissions WHERE user_id = ? AND company_id = ?", [userId, companyId])) || [];
    const owned = new Set(have.map((h) => h.module_key));
    for (const m of template.modules) {
      if (!owned.has(m)) await queryDB("INSERT INTO admin_module_permissions (user_id, module_key, company_id) VALUES (?, ?, ?)", [userId, m, companyId]);
    }
  }
  await queryDB("INSERT INTO user_access_audit (target_user_id, actor_user_id, action, detail) VALUES (?, ?, ?, ?)", [
    userId,
    actorId,
    "access-template",
    JSON.stringify({ features: template.features, modules: template.modules, _template: template.name }).slice(0, 4000)
  ]).catch(() => undefined);
}

// Ready-made templates for three jobs (Admin Panel -> Users -> Module Access
// -> Apply template…): HR from onboarding to exit and payroll, Accounts
// paying bills and salaries, and Audit checking payroll. Put in each company
// once (marker role_templates_v1_c<company>), so one HR renames, changes or
// deletes stays that way. A template only fills the Module Access page for
// the accounts picked; nothing is granted until someone with the right to
// grant presses Save, and each change goes through that person's own checks.
export const ROLE_TEMPLATES: { name: string; description: string; modules: string[]; layers: Record<string, string[]>; flags: Record<string, boolean> }[] = [
  {
    name: "HR - Onboarding to Exit & Payroll",
    description: "Recruitment, onboarding, employees, attendance, leave, roster, payroll (make & run), exit. Not: HR Director review, Accounts Pay, Audit.",
    modules: [
      "admin_dashboard",
      "notices",
      "holidays",
      "departments",
      "designations",
      "attendance",
      "attendance_reports",
      "leave_applications",
      "office_attendance",
      "duty_roster",
      "employees",
      "hr_operations",
      "recruitment",
      "exit_offboarding",
      "document_vault",
      "performance_management",
      "grievance_disciplinary",
      "hr_analytics",
      "payroll"
    ],
    layers: {
      notices: ["read", "notice_read_report"],
      departments: ["read", "edit_add"],
      designations: ["read", "edit_add"],
      attendance_reports: ["read", "late_list", "dept_summary", "custom_report", "attendance_edit"],
      office_attendance: ["read", "link_pins"],
      duty_roster: ["read", "roster_manage", "ot_approve"],
      employees: ["read", "emp_headcount", "emp_export"],
      hr_operations: ["read", "onboarding_create", "onboarding_review", "onboarding_approve", "reminders_receive", "requisitions", "quick_reports", "quick_ot", "hr_headcount", "hr_emp_export"],
      recruitment: ["read", "email_candidates", "edit_candidates"],
      exit_offboarding: ["read", "exit_dues", "exit_pdf"],
      document_vault: ["read", "sign_request"],
      payroll: ["read", "salary_amounts", "approval_sheet", "month_compare", "top_sheet", "salary_month", "salary_hold", "salary_bulk_upload", "ot_rules"],
      leave_manage: ["edit_balance", "bulk_set_balance", "add_category", "edit_policy", "year_settings", "workflow_manage"]
    },
    flags: { can_manage_leave: true }
  },
  {
    name: "Accounts - Bill Disbursement & Pay",
    description: "Pay out approved bills (Bill Disbursement) and pay salaries / loans (Payroll view only + Accounts Pay). Put them on the Bill Claim template's Pay Out layer too.",
    modules: ["disbursement", "payroll"],
    layers: { payroll: ["payroll_view", "salary_amounts", "accounts_pay", "approval_sheet", "month_compare", "top_sheet"] },
    // Leave Manage is an HR power: applying this turns it off.
    flags: { can_manage_leave: false }
  },
  {
    name: "Audit - Payroll (view only)",
    description: "Sees every Payroll page and report, changes nothing; checks a paid month (Audit after payment) and the Activity Log.",
    modules: ["payroll"],
    layers: { payroll: ["payroll_view", "salary_amounts", "audit_approve", "access_log", "approval_sheet", "month_compare", "top_sheet"] },
    flags: { can_manage_leave: false }
  }
];

// Called inside a request (like ensureDefaultAccessTemplate), so the rows are
// the active company's; companyId names the marker.
export async function ensureRoleAccessTemplates(queryDB: QueryDB, companyId: number): Promise<void> {
  const marker = `role_templates_v1_c${companyId}`;
  try {
    const done: any[] = (await queryDB("/*unscoped*/ SELECT name FROM startup_migrations WHERE name = ?", [marker])) || [];
    if (done.length) return;
    const have: any[] = (await queryDB("SELECT name FROM access_templates")) || [];
    const names = new Set(have.map((r) => String(r.name)));
    for (const t of ROLE_TEMPLATES) {
      if (names.has(t.name)) continue;
      const access = { modules: t.modules, layers: t.layers, flags: t.flags, app: null };
      const features = TEMPLATE_FEATURES.filter((f) => t.flags[f] === true);
      await queryDB("INSERT INTO access_templates (name, description, features_json, modules_json, access_json) VALUES (?, ?, ?, ?, ?)", [
        t.name,
        t.description,
        JSON.stringify(features),
        JSON.stringify(t.modules),
        JSON.stringify(access)
      ]);
    }
    await queryDB("/*unscoped*/ INSERT INTO startup_migrations (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [marker, String(ROLE_TEMPLATES.length)]);
  } catch (err: any) {
    console.warn("⚠️ Could not add the HR / Accounts / Audit access templates: " + err.message);
  }
}
