/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Mobile App (APK) access, separate from the website (Admin Panel -> Users ->
// Module Access: a "Mobile App (APK) access" switch, and an App tick next to
// every module and Self Service switch).
//
//   users.can_use_app       0 = this account can't sign in to the app at all
//                           (accounts that existed before this feature: 1;
//                           new accounts: 0).
//   users.app_access_custom 0 = the app gets exactly what the website has;
//                           1 = only the items in user_app_access.
//   user_app_access         (user_id, company_id, item_key): the App ticks —
//                           Admin Panel module keys per company, Self Service
//                           switch keys (can_*) with company_id 0.
//
// An App tick never grants more than the website: what the app gets is the
// website's access with the un-ticked items taken away. That is done in one
// place — queryDB() calls maskRowsForApp() for every query run inside an app
// request, which drops the account's own admin_module_permissions rows and
// turns off its own users.can_* switches that aren't ticked for the app. So
// requireModule / requireModuleLayer / every Self Service check and the
// user object the app gets (login, /me) all see the app's narrower access.
// A Superadmin and the system owner are never limited.

import { AsyncLocalStorage } from "async_hooks";
import type { Express } from "express";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

// Every Self Service switch that has an App tick (ModuleAccessPage.tsx FLAGS).
export const APP_FLAG_KEYS = [
  "can_access_user_panel", "can_use_attendance", "can_use_tracking", "can_view_leave_summary", "can_edit_delivery_date",
  "can_job_edit", "can_manage_leave", "can_view_movement_claims", "can_view_bill_claims", "can_view_budget_module",
  "can_view_timesheet", "can_view_leave_application", "can_view_group_dashboard", "can_view_tasks", "can_view_mobile_bill",
  "can_view_service_book", "can_view_loan_request", "can_view_targets", "can_use_ai_assistant", "can_export_assistant_reports",
  "can_handle_assistant_support", "can_use_calls", "can_use_disappearing", "can_use_chat", "can_use_mail", "can_view_mail_directory",
  "can_use_mail_groups", "can_receive_material", "can_return_dispatch", "can_give_feedback", "can_use_fingerprint",
  "can_view_roster", "can_take_break", "can_save_ride_places", "can_update_check_out", "can_add_adhoc_approver",
  "can_use_assistant_voice", "can_sign_documents", "can_view_payslip", "can_request_items", "can_email_reports", "can_view_my_ot", "can_approve_team_ot",
  // Leave Application's older companion switch, on and off with it.
  "can_view_my_leave"
] as const;
const FLAG_SET = new Set<string>(APP_FLAG_KEYS);
// A switch that goes with another one in the app (no tick of its own).
const FLAG_FOLLOWS: Record<string, string> = { can_view_my_leave: "can_view_leave_application" };

export interface AppMask {
  userId: number;
  modules: Set<string>;
  flags: Set<string>;
}

// The app request now running, when its access is narrower than the website's.
export const appMaskStore = new AsyncLocalStorage<AppMask | null>();
export const currentAppMask = (): AppMask | null => appMaskStore.getStore() || null;

const isMe = (m: AppMask, row: any, rowKey: string, params?: any[]) =>
  row[rowKey] !== undefined && row[rowKey] !== null ? Number(row[rowKey]) === m.userId : Number(params?.[0]) === m.userId;

/** queryDB() runs every result through this; a no-op outside a limited app request. */
export function maskRowsForApp(sql: string, params: any[] | undefined, rows: any): any {
  const m = currentAppMask();
  if (!m || !Array.isArray(rows) || rows.length === 0) return rows;
  let out = rows;
  if (/admin_module_permission/i.test(sql) && rows[0] && "module_key" in rows[0]) {
    out = out.filter((r: any) => !(isMe(m, r, "user_id", params) && !m.modules.has(String(r.module_key))));
  }
  if (/\busers\b/i.test(sql) && out[0] && Object.keys(out[0]).some((k) => FLAG_SET.has(k))) {
    out = out.map((r: any) => {
      if (!isMe(m, r, "id", params)) return r;
      const copy = { ...r };
      for (const k of Object.keys(copy)) {
        if (FLAG_SET.has(k) && !m.flags.has(FLAG_FOLLOWS[k] || k)) copy[k] = 0;
      }
      return copy;
    });
  }
  return out;
}

export async function ensureAppAccessSchema(queryDB: QueryDB) {
  const cols: any[] = await queryDB(
    "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME IN ('can_use_app','app_access_custom')"
  );
  const have = new Set((cols || []).map((r: any) => r.c));
  if (!have.has("can_use_app")) {
    // Everyone who already exists keeps the app; accounts made from now on
    // start without it (the default changes right after the column is added).
    await queryDB("ALTER TABLE users ADD COLUMN can_use_app TINYINT(1) NOT NULL DEFAULT 1");
    await queryDB("ALTER TABLE users ALTER COLUMN can_use_app SET DEFAULT 0");
  }
  if (!have.has("app_access_custom")) {
    await queryDB("ALTER TABLE users ADD COLUMN app_access_custom TINYINT(1) NOT NULL DEFAULT 0");
  }
  await queryDB(`CREATE TABLE IF NOT EXISTS user_app_access (
    user_id INT NOT NULL,
    company_id INT NOT NULL DEFAULT 0,
    item_key VARCHAR(64) NOT NULL,
    PRIMARY KEY (user_id, company_id, item_key)
  )`);
}

const exempt = (u: any) => u?.role === "superadmin" || Number(u?.is_platform_admin || 0) === 1;

// Per account + company, for a few seconds (every app request needs it).
const cache = new Map<string, { at: number; v: { canUse: boolean; mask: AppMask | null } }>();
export const forgetAppAccess = (userId: number) => {
  for (const k of [...cache.keys()]) if (k.startsWith(`${userId}:`)) cache.delete(k);
};

/** What an app request of this account may use: null mask = same as the website. */
export async function appAccessFor(queryDB: QueryDB, userId: number, companyId: number): Promise<{ canUse: boolean; mask: AppMask | null }> {
  const key = `${userId}:${companyId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.v;
  const rows: any[] = await queryDB("/*unscoped*/ SELECT role, is_platform_admin, is_onboarding, can_use_app, app_access_custom FROM users WHERE id = ?", [userId]);
  const u = rows?.[0];
  let v: { canUse: boolean; mask: AppMask | null };
  if (!u) v = { canUse: false, mask: null };
  // A new joiner's temporary login only reaches My Onboarding anyway — it
  // works in the app as before.
  else if (exempt(u) || Number(u.is_onboarding || 0) === 1) v = { canUse: true, mask: null };
  else if (!Number(u.can_use_app ?? 1)) v = { canUse: false, mask: null };
  else if (!Number(u.app_access_custom || 0)) v = { canUse: true, mask: null };
  else {
    const items: any[] = await queryDB("/*unscoped*/ SELECT company_id, item_key FROM user_app_access WHERE user_id = ? AND company_id IN (0, ?)", [userId, companyId]);
    const modules = new Set<string>();
    const flags = new Set<string>();
    for (const r of items || []) (Number(r.company_id) === 0 ? flags : modules).add(String(r.item_key));
    v = { canUse: true, mask: { userId, modules, flags } };
  }
  cache.set(key, { at: Date.now(), v });
  return v;
}

export const APP_OFF_MESSAGE = "The mobile app isn't turned on for your account. Use the website, or ask HR to turn it on.";

interface Deps {
  authenticateToken: any;
  requireModuleGrantAccess: any;
  queryDB: QueryDB;
  adminModuleKeys: readonly string[];
  activeCompanyId: () => number;
}

export function registerAppAccessRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireModuleGrantAccess, queryDB, adminModuleKeys, activeCompanyId } = deps;

  // A Superadmin may set anyone; an Admin with "can grant Module Access"
  // only a plain User (same rule as the module and Self Service switches).
  const targetOk = async (req: any, res: any) => {
    const t: any[] = await queryDB("SELECT id, role FROM users WHERE id = ?", [req.params.id]);
    if (!t.length) return void res.status(404).json({ error: "User not found" }), null;
    if (t[0].role === "superadmin") return void res.status(400).json({ error: "A Superadmin always has the app." }), null;
    if (req.user?.role !== "superadmin" && t[0].role !== "user") {
      return void res.status(403).json({ error: "Only the Superadmin can change another Admin's access." }), null;
    }
    return t[0];
  };

  // GET — every listed account's app settings (Module Access opens several).
  app.get("/api/app-access", authenticateToken, requireModuleGrantAccess, async (req: any, res: any) => {
    try {
      const ids = String(req.query.ids || "")
        .split(",")
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(0, 200);
      if (!ids.length) return res.json({ items: [] });
      const marks = ids.map(() => "?").join(",");
      const users: any[] = await queryDB(`SELECT id, can_use_app, app_access_custom FROM users WHERE id IN (${marks})`, ids);
      const rows: any[] = await queryDB(`/*unscoped*/ SELECT user_id, company_id, item_key FROM user_app_access WHERE user_id IN (${marks}) AND company_id IN (0, ?)`, [...ids, activeCompanyId()]);
      res.json({
        items: users.map((u) => ({
          id: Number(u.id),
          can_use_app: !!Number(u.can_use_app ?? 1),
          custom: !!Number(u.app_access_custom || 0),
          app: rows.filter((r) => Number(r.user_id) === Number(u.id)).map((r) => String(r.item_key))
        }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT { can_use_app, app?: string[] } — app omitted = the app gets what the
  // website has; a list = only those (modules of the company now open, and
  // Self Service switches).
  app.put("/api/users/:id/app-access", authenticateToken, requireModuleGrantAccess, async (req: any, res: any) => {
    try {
      const target = await targetOk(req, res);
      if (!target) return;
      const id = Number(target.id);
      const canUse = !!req.body?.can_use_app;
      const list: string[] | null = Array.isArray(req.body?.app) ? req.body.app.map(String) : null;
      await queryDB("UPDATE users SET can_use_app = ?, app_access_custom = ? WHERE id = ?", [canUse ? 1 : 0, list ? 1 : 0, id]);
      if (list) {
        const companyId = activeCompanyId();
        const modules = [...new Set(list.filter((k) => adminModuleKeys.includes(k)))];
        const flags = [...new Set(list.filter((k) => FLAG_SET.has(k) && !FLAG_FOLLOWS[k]))];
        await queryDB("/*unscoped*/ DELETE FROM user_app_access WHERE user_id = ? AND company_id IN (0, ?)", [id, companyId]);
        for (const k of modules) await queryDB("/*unscoped*/ INSERT IGNORE INTO user_app_access (user_id, company_id, item_key) VALUES (?, ?, ?)", [id, companyId, k]);
        for (const k of flags) await queryDB("/*unscoped*/ INSERT IGNORE INTO user_app_access (user_id, company_id, item_key) VALUES (?, 0, ?)", [id, k]);
      }
      forgetAppAccess(id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
