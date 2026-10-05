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
  can_view_conveyance_claims: ["can_view_conveyance_claims"],
  can_view_timesheet: ["can_view_timesheet"],
  // Leave Application and My Leave are one switch in Module Access.
  can_view_leave_application: ["can_view_leave_application", "can_view_my_leave"],
  can_view_tasks: ["can_view_tasks"],
  can_view_mobile_bill: ["can_view_mobile_bill"]
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
    "can_view_conveyance_claims",
    "can_view_timesheet",
    "can_view_leave_application",
    "can_view_tasks",
    "can_view_mobile_bill"
  ],
  modules: [] as string[]
};

export async function ensureAccessTemplateSchema(queryDB: QueryDB) {
  try {
    await queryDB("ALTER TABLE access_templates ADD COLUMN is_default TINYINT(1) NOT NULL DEFAULT 0");
  } catch (err: any) {
    if (err?.code !== "ER_DUP_FIELDNAME") console.warn("⚠️ Could not add access_templates.is_default column: " + err.message);
  }
}

const parseList = (v: any): string[] => {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};

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
