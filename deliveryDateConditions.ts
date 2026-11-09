/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin-configurable "minimum lead time" rule for Delivery Date, enforced in
// two independent places (see EntriesRoutes.ts):
//   - "entry"    — POST /api/entries (New Job Entry) and
//                  POST /api/entries/job/:jobId/items (Add MPR to Job)
//   - "job_edit" — PUT /api/entries/:id (changing an EXISTING entry's
//                  Delivery Date, from Job Edit / Job Entry Details)
// Each has its own independent Global setting plus optional per-Project or
// per-Budget overrides (Admin Panel -> PEPM Manage -> Data Import ->
// Condition Set). Resolution order for a given entry: a Budget-specific
// override wins if one exists, else a Project-specific override, else the
// Global setting, else (nothing configured/enabled) no restriction at all.

export type DeliveryConditionType = "entry" | "job_edit";
export type DeliveryConditionScope = "global" | "project" | "budget";

export interface DeliveryDateConditionRow {
  id: number;
  condition_type: DeliveryConditionType;
  scope: DeliveryConditionScope;
  scope_id: number;
  min_lead_days: number;
  apply_to_admins: number;
  enabled: number;
}

// Resolves the effective minimum-lead-days rule for one delivery-date
// decision. Returns null when nothing applies (unrestricted) — either
// because no condition is enabled at any scope, or because the only
// matching one is Global/Project/Budget but `apply_to_admins` is off and
// this user is an Admin/Superadmin.
export async function resolveMinLeadDays(
  queryDB: (sql: string, params?: any[]) => Promise<any>,
  conditionType: DeliveryConditionType,
  opts: { projectId?: number | null; budgetId?: number | null; userRole: string }
): Promise<number | null> {
  const rows: DeliveryDateConditionRow[] = await queryDB(
    `SELECT * FROM delivery_date_conditions
     WHERE condition_type = ? AND enabled = 1
       AND (
         (scope = 'budget' AND scope_id = ?) OR
         (scope = 'project' AND scope_id = ?) OR
         scope = 'global'
       )`,
    [conditionType, opts.budgetId || 0, opts.projectId || 0]
  );
  const byScope = (s: DeliveryConditionScope) => rows.find((r) => r.scope === s);
  const effective = byScope("budget") || byScope("project") || byScope("global");
  if (!effective) return null;

  const isAdmin = opts.userRole === "admin" || opts.userRole === "superadmin";
  if (isAdmin && !Number(effective.apply_to_admins)) return null;

  return Number(effective.min_lead_days);
}

// `dateStr` + `days` -> "YYYY-MM-DD", computed in UTC so it's never shifted a
// day by the server process's local timezone (same reasoning as
// src/lib/formatDate.ts's dateRangeOptions on the client).
export function addDaysToDateStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---- Material conditions (Condition Set -> Material conditions) ----
// A named group of materials (Description of Material) with its own minimum
// days' notice, for New Job Entry / Add MPR and/or Job Edit
// (MaterialConditionsRoutes.ts). Where it applies together with the
// Global / Project / Budget rule above, the stricter one (more days) wins.

/** The one way a material name is compared: case, spaces and ends ignored. */
export const materialKey = (s: unknown): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export interface MaterialRule {
  key: string;
  days: number;
  name: string;
}

// The material conditions that apply to this account for this kind of change
// (on, ticked for the type, and for an Admin only when "Admins too").
export async function materialRules(
  queryDB: (sql: string, params?: any[]) => Promise<any>,
  conditionType: DeliveryConditionType,
  userRole: string
): Promise<Map<string, MaterialRule>> {
  const col = conditionType === "entry" ? "c.applies_entry" : "c.applies_job_edit";
  const isAdmin = userRole === "admin" || userRole === "superadmin";
  const rows: any[] =
    (await queryDB(
      `SELECT c.name, c.min_lead_days, c.apply_to_admins, i.material_key
         FROM delivery_material_conditions c
         JOIN delivery_material_condition_items i ON i.condition_id = c.id
        WHERE c.enabled = 1 AND ${col} = 1`
    ).catch(() => [])) || [];
  const out = new Map<string, MaterialRule>();
  for (const r of rows) {
    if (isAdmin && !Number(r.apply_to_admins)) continue;
    out.set(String(r.material_key), { key: String(r.material_key), days: Number(r.min_lead_days), name: String(r.name) });
  }
  return out;
}

// Checks every item's Delivery Date against the stricter of the general rule
// and its material's rule; the first one too early gives the message.
export async function leadTimeProblem(
  queryDB: (sql: string, params?: any[]) => Promise<any>,
  conditionType: DeliveryConditionType,
  opts: { projectId?: number | null; budgetId?: number | null; userRole: string },
  items: { material: string; date: string }[],
  today: string
): Promise<string | null> {
  const general = await resolveMinLeadDays(queryDB, conditionType, opts);
  const rules = await materialRules(queryDB, conditionType, opts.userRole);
  for (const it of items) {
    const d = String(it.date || "").slice(0, 10);
    if (!d) continue;
    const m = rules.get(materialKey(it.material));
    const days = Math.max(general ?? -1, m?.days ?? -1);
    if (days < 0) continue;
    const earliest = addDaysToDateStr(today, days);
    if (d < earliest) {
      return m && m.days >= (general ?? -1)
        ? `"${String(it.material).trim()}" needs at least ${days} day(s) notice (${m.name}) — the earliest allowed date is ${earliest}.`
        : `Delivery Date needs at least ${days} day(s) notice — the earliest allowed date is ${earliest}.`;
    }
  }
  return null;
}
