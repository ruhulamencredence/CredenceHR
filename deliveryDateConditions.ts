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
