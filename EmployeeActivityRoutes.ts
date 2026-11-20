/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> Service Book: what else happened to one Employee, beyond
// the official service history (buildServiceBook, which the Service Book PDF
// and the employee's own My Service Book keep using unchanged).
//
//   GET /api/hr-ops/p360/:employeeId/activity — the extra timeline events:
//     onboarding (joiner login, form, Appointment Letter issued / signed,
//     approval), login created / blocked / Mobile App, PEPM projects given or
//     taken, Check-in places, final settlement. HR view only.
//   GET /api/hr-ops/p360/:employeeId/more — "More activity": a short summary
//     from other modules (SIM & Mobile Bill, rides, requisitions, grievances,
//     tasks & targets, exit). Each box only for a viewer who holds that
//     module; amounts of money only with Payroll.
//   GET /api/hr-ops/p360/:employeeId/access-log — "Login & Access": every
//     recorded change to the login (UserAccessLog.ts). Its own explicit-only
//     layer, hr_operations -> p360_access.
//
// All three only read. Each source is read on its own and a missing table
// or a failing query just leaves that part out.

import type { Express } from "express";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface Deps {
  authenticateToken: any;
  requireModule: (k: "hr_operations") => any;
  requireModuleLayer: (k: "hr_operations", layer: "p360_access") => any;
  hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
  getAdminModules: (userId: number) => Promise<string[]>;
  queryDB: QueryDB;
}

export interface ActivityEvent {
  date: string | null;
  at: string | null;
  kind: "onboarding" | "pepm" | "login" | "checkin" | "exit";
  title: string;
  detail: string | null;
  by: string | null;
}

const iso = (v: any): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v).replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d.toISOString();
};
// Dhaka calendar date of a timestamp.
const dhakaDay = (v: any): string | null => {
  const s = iso(v);
  return s ? new Date(new Date(s).getTime() + 6 * 3600e3).toISOString().slice(0, 10) : null;
};
const safe = async (q: Promise<any>): Promise<any[]> => {
  try {
    return ((await q) as any[]) || [];
  } catch {
    return [];
  }
};
const parse = (s: any) => {
  try {
    return JSON.parse(String(s || "[]"));
  } catch {
    return [];
  }
};
const money = (n: any) => `BDT ${Number(n || 0).toLocaleString("en-IN")}`;

export function registerEmployeeActivityRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireModule, requireModuleLayer, hasModuleLayer, getAdminModules, queryDB } = deps;
  const gate = [authenticateToken, requireModule("hr_operations")];

  async function viewerModules(req: any): Promise<Set<string>> {
    if (req.user.role === "superadmin") return new Set(["*"]);
    return new Set(await getAdminModules(Number(req.user.id)).catch(() => []));
  }
  const has = (mods: Set<string>, key: string) => mods.has("*") || mods.has(key);

  // The Employee, from the company being worked in (queryDB scopes it).
  async function employeeOf(req: any, res: any): Promise<any | null> {
    const id = Number(req.params.employeeId);
    const rows = id ? await safe(queryDB("SELECT id, name, user_id FROM all_employees WHERE id = ?", [id])) : [];
    const e = rows.find((r: any) => Number(r.id) === id);
    if (!e) {
      res.status(404).json({ error: "Employee not found." });
      return null;
    }
    return e;
  }
  async function namesOf(ids: any[]): Promise<Map<number, string>> {
    const list = [...new Set(ids.map(Number).filter((n) => n > 0))];
    if (!list.length) return new Map();
    const rows = await safe(
      queryDB(`/*unscoped*/ SELECT u.id, COALESCE(e.name, u.name) AS name FROM users u LEFT JOIN all_employees e ON e.user_id = u.id WHERE u.id IN (${list.map(() => "?").join(",")})`, list)
    );
    return new Map(rows.map((r: any) => [Number(r.id), String(r.name || "")]));
  }
  async function logRows(userId: number | null, empId: number): Promise<any[]> {
    return safe(
      queryDB("/*unscoped*/ SELECT * FROM user_access_log WHERE (user_id = ? OR employee_id = ?) ORDER BY created_at DESC, id DESC LIMIT 500", [userId || 0, empId])
    );
  }

  const changeText = (c: any): string => {
    if (Array.isArray(c.added) || Array.isArray(c.removed)) {
      return [...(c.added || []).map((x: string) => `+ ${x}`), ...(c.removed || []).map((x: string) => `− ${x}`)].join(", ");
    }
    if (c.from != null && c.to != null) return `${c.from} → ${c.to}`;
    return String(c.to ?? c.from ?? "");
  };

  // Before this log began, Users -> Manage -> Activity (user_access_audit,
  // UserManagement.ts) already kept each change's request — which route and
  // what was sent, not what it was before. Those older rows fill in the
  // history from before; nothing is shown twice.
  async function olderAudit(userId: number | null): Promise<{ at: string | null; by: string | null; action: string; changes: any[] }[]> {
    if (!userId) return [];
    const first = (await safe(queryDB("/*unscoped*/ SELECT MIN(created_at) AS at FROM user_access_log")))[0]?.at || null;
    const rows = await safe(
      queryDB(
        `SELECT id, action, detail, actor_user_id, created_at FROM user_access_audit WHERE target_user_id = ?${first ? " AND created_at < ?" : ""} ORDER BY id DESC LIMIT 300`,
        first ? [userId, first] : [userId]
      )
    );
    const mine = rows.filter((r: any) => r.action !== "delete");
    if (!mine.length) return [];
    const names = await namesOf(mine.map((r: any) => r.actor_user_id));
    const pids = new Set<number>();
    for (const r of mine) for (const id of (parse(r.detail) as any)?.project_ids || []) pids.add(Number(id));
    const pRows = pids.size ? await safe(queryDB(`/*unscoped*/ SELECT id, project_name FROM projects WHERE id IN (${[...pids].map(() => "?").join(",")})`, [...pids])) : [];
    const pName = new Map(pRows.map((p: any) => [Number(p.id), String(p.project_name)]));
    return mine.map((r: any) => {
      const d: any = parse(r.detail) || {};
      const sub = String(r.action || "");
      const changes: any[] = [];
      if (sub === "block") changes.push({ what: "Login", to: d.blocked ? `Blocked${d.reason ? ` · ${d.reason}` : ""}` : "Open" });
      else if (sub === "reset-password" || sub === "password-request-reset") changes.push({ what: "Password", to: "Reset" });
      else if (sub === "projects") changes.push({ what: "PEPM projects", to: `Set to: ${(d.project_ids || []).map((id: any) => pName.get(Number(id)) || `#${id}`).join(", ") || "none"}` });
      else if (sub === "module-permissions") changes.push({ what: "Module access", to: `Set to: ${(d.modules || []).join(", ") || "none"}` });
      else if (sub === "module-permission-layers") changes.push({ what: "Permission layers", to: `${d.module || ""}: ${(d.layers || []).join(", ") || "none"}` });
      else if (sub === "app-access") changes.push({ what: "Mobile App", to: d.can_use_app ? "On" : "Off" });
      else {
        for (const [k, v] of Object.entries(d)) {
          if (k.startsWith("_")) continue;
          changes.push({ what: k.replace(/^can_(view_|use_)?/, "").replace(/_/g, " "), to: typeof v === "boolean" ? (v ? "On" : "Off") : Array.isArray(v) ? v.join(", ") : String(v ?? "") });
        }
        if (!changes.length) changes.push({ what: "Changed", to: sub });
      }
      return { at: iso(r.created_at), by: names.get(Number(r.actor_user_id)) || null, action: sub.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()), changes };
    });
  }

  // ---- timeline ----
  app.get("/api/hr-ops/p360/:employeeId/activity", ...gate, async (req: any, res: any) => {
    try {
      const e = await employeeOf(req, res);
      if (!e) return;
      const empId = Number(e.id);
      const userId = e.user_id ? Number(e.user_id) : null;
      const mods = await viewerModules(req);
      const events: ActivityEvent[] = [];
      const push = (at: any, kind: ActivityEvent["kind"], title: string, detail: string | null, by: string | null = null) => {
        const d = dhakaDay(at);
        if (d) events.push({ date: d, at: iso(at), kind, title, detail, by });
      };

      // Onboarding: the joiner's application and its Appointment Letter.
      const apps = await safe(queryDB("SELECT * FROM onboarding_applications WHERE employee_id = ?", [empId]));
      const appIds = apps.map((a: any) => Number(a.id));
      const names = await namesOf([...apps.map((a: any) => a.created_by), ...apps.map((a: any) => a.reviewed_by)]);
      for (const a of apps.filter((x: any) => Number(x.employee_id) === empId)) {
        push(a.created_at, "onboarding", "Onboarding started", `Joiner login ${a.onb_code || ""} opened`.trim(), names.get(Number(a.created_by)) || null);
        if (a.submitted_at) push(a.submitted_at, "onboarding", "Joiner form submitted", null);
        if (a.reviewed_at && String(a.status).toLowerCase() === "approved") push(a.reviewed_at, "onboarding", "Onboarding approved", "Became an Employee", names.get(Number(a.reviewed_by)) || null);
      }
      if (appIds.length) {
        const letters = await safe(queryDB(`/*unscoped*/ SELECT ref_no, letter_date, created_at, acknowledged_at, status, onboarding_id FROM hr_letters WHERE onboarding_id IN (${appIds.map(() => "?").join(",")})`, appIds));
        for (const l of letters) {
          push(l.created_at, "onboarding", "Appointment Letter issued", l.ref_no || null);
          if (l.acknowledged_at) push(l.acknowledged_at, "onboarding", "Appointment Letter signed", `${l.ref_no || ""} · signed copy uploaded`.replace(/^ · /, ""));
          if (String(l.status) === "cancelled") push(l.created_at, "onboarding", "Appointment Letter cancelled", l.ref_no || null);
        }
      }

      // The login and what was changed on it.
      const logs = await logRows(userId, empId);
      const logged = new Set<string>();
      for (const r of logs) {
        const changes: any[] = parse(r.changes_json);
        for (const c of changes) {
          const what = String(c.what || "");
          let kind: ActivityEvent["kind"] | null = null;
          let title = "";
          if (what === "PEPM projects") {
            kind = "pepm";
            title = c.added?.length && !c.removed?.length ? "PEPM project given" : !c.added?.length && c.removed?.length ? "PEPM project taken away" : "PEPM projects changed";
          } else if (what === "Check-in places") {
            kind = "checkin";
            title = "Check-in place changed";
          } else if (what === "Login") {
            kind = "login";
            title = /created/i.test(String(c.to)) ? "Login created" : /blocked/i.test(String(c.to)) ? "Login blocked" : "Login opened again";
          } else if (what === "Mobile App") {
            kind = "login";
            title = `Mobile App ${String(c.to) === "On" ? "turned on" : "turned off"}`;
          } else if (what === "Role" || what === "Password") {
            kind = "login";
            title = what === "Role" ? "Role changed" : "Password reset";
          }
          if (!kind) continue;
          logged.add(title);
          push(r.created_at, kind, title, what === "Password" ? null : changeText(c) || null, r.actor_name || null);
        }
      }

      // From before the log started: block / Mobile App from the older audit.
      for (const o of await olderAudit(userId)) {
        for (const c of o.changes) {
          if (c.what === "Login") push(o.at, "login", /^Blocked/.test(c.to) ? "Login blocked" : "Login opened again", c.to, o.by);
          else if (c.what === "Mobile App") push(o.at, "login", `Mobile App ${c.to === "On" ? "turned on" : "turned off"}`, null, o.by);
          else if (c.what === "Password") push(o.at, "login", "Password reset", null, o.by);
        }
      }
      // …and the login itself and the projects it still has.
      if (userId) {
        const u = (await safe(queryDB("/*unscoped*/ SELECT created_at FROM users WHERE id = ?", [userId])))[0];
        if (u && !logged.has("Login created")) push(u.created_at, "login", "Login created", null);
        const firstLog = logs.length ? iso(logs[logs.length - 1].created_at) : null;
        const projects = await safe(
          queryDB("/*unscoped*/ SELECT x.created_at, p.project_name FROM user_project_permissions x LEFT JOIN projects p ON p.id = x.project_id WHERE x.user_id = ?", [userId])
        );
        for (const p of projects) {
          const at = iso(p.created_at);
          if (at && (!firstLog || at < firstLog)) push(p.created_at, "pepm", "PEPM project given", p.project_name || null);
        }
      }

      // Final settlement (the exit itself is already in the service history).
      if (userId) {
        const settlements = await safe(queryDB("SELECT * FROM final_settlements WHERE user_id = ?", [userId]));
        const pay = has(mods, "payroll");
        for (const s of settlements.filter((x: any) => Number(x.user_id) === userId)) {
          push(s.created_at, "exit", "Final settlement prepared", pay ? `Net payable ${money(s.net_payable)}` : null);
          if (s.paid_at) push(s.paid_at, "exit", "Final settlement paid", pay ? money(s.net_payable) : null);
        }
      }

      events.sort((a, b) => String(b.at || b.date).localeCompare(String(a.at || a.date)));
      res.json({ events, can_access_log: await hasModuleLayer(req.user, "hr_operations", "p360_access").catch(() => false) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- More activity ----
  app.get("/api/hr-ops/p360/:employeeId/more", ...gate, async (req: any, res: any) => {
    try {
      const e = await employeeOf(req, res);
      if (!e) return;
      const empId = Number(e.id);
      const userId = e.user_id ? Number(e.user_id) : 0;
      const mods = await viewerModules(req);
      const pay = has(mods, "payroll");
      const year = new Date(Date.now() + 6 * 3600e3).getUTCFullYear();
      const boxes: any[] = [];

      if (has(mods, "mobile_bill")) {
        const sims = await safe(queryDB("SELECT id, phone_number, operator, limit_amount, status, issued_on FROM mobile_sims WHERE employee_id = ?", [empId]));
        const bills = await safe(queryDB("SELECT bill_month, amount, limit_amount, paid_at FROM mobile_bills WHERE employee_id = ? ORDER BY bill_month DESC LIMIT 6", [empId]));
        boxes.push({
          key: "mobile_bill",
          title: "SIM & Mobile Bill",
          sub: sims.length ? sims.map((s: any) => `${s.phone_number} · ${s.operator}${String(s.status) !== "active" ? ` (${s.status})` : ""}`).join(", ") : "No SIM given",
          rows: bills.map((b: any) => ({
            label: `Bill ${b.bill_month}`,
            value: money(b.amount),
            tone: Number(b.limit_amount) > 0 && Number(b.amount) > Number(b.limit_amount) ? "warn" : b.paid_at ? "ok" : null,
            note: Number(b.limit_amount) > 0 && Number(b.amount) > Number(b.limit_amount) ? `over limit ${money(b.limit_amount)}` : null
          })),
          link: "/admin/mobile-bill"
        });
      }
      if (has(mods, "vehicle_management") && userId) {
        const rides = await safe(queryDB("SELECT id, destination, ride_date, status FROM vehicle_requisitions WHERE employee_user_id = ? ORDER BY ride_date DESC, id DESC LIMIT 200", [userId]));
        const mine = rides;
        const thisYear = mine.filter((r: any) => String(dhakaDay(r.ride_date) || r.ride_date || "").startsWith(String(year))).length;
        boxes.push({
          key: "vehicle",
          title: "Rides",
          sub: `${thisYear} this year · ${mine.length} in all`,
          rows: mine.slice(0, 5).map((r: any) => ({ label: r.destination || `Ride #${r.id}`, value: dhakaDay(r.ride_date) || "", status: r.status })),
          link: "/admin/vehicle-management"
        });
      }
      if (has(mods, "asset_management") && userId) {
        const reqs = await safe(queryDB("SELECT id, asset_category, status, created_at FROM asset_requisitions WHERE employee_user_id = ? ORDER BY created_at DESC LIMIT 5", [userId]));
        boxes.push({
          key: "asset_requisitions",
          title: "Asset requisitions",
          sub: reqs.length ? "Latest asked for" : "Nothing asked for",
          rows: reqs.map((r: any) => ({ label: r.asset_category || `Requisition #${r.id}`, value: dhakaDay(r.created_at) || "", status: r.status })),
          link: "/admin/asset-management"
        });
      }
      if (has(mods, "grievance_disciplinary") && userId) {
        // Anonymous grievances are never tied back to the person here.
        const raised = await safe(queryDB("SELECT id, category, status, created_at FROM grievances WHERE raised_by = ? AND COALESCE(is_anonymous, 0) = 0 ORDER BY created_at DESC LIMIT 5", [userId]));
        const against = await safe(queryDB("SELECT id, category, status, created_at FROM grievances WHERE against_user_id = ? ORDER BY created_at DESC LIMIT 5", [userId]));
        boxes.push({
          key: "grievance",
          title: "Grievances",
          sub: `${raised.length} raised by them (not anonymous) · ${against.length} about them`,
          rows: [
            ...raised.map((g: any) => ({ label: `Raised: ${g.category || "Grievance"}`, value: dhakaDay(g.created_at) || "", status: g.status })),
            ...against.map((g: any) => ({ label: `About them: ${g.category || "Grievance"}`, value: dhakaDay(g.created_at) || "", status: g.status }))
          ],
          link: "/admin/grievance-disciplinary"
        });
      }
      if (has(mods, "task_management") && userId) {
        const tasks = await safe(
          queryDB("SELECT t.id, t.title, t.status, t.due_date FROM tasks t JOIN task_assignees a ON a.task_id = t.id WHERE a.user_id = ? ORDER BY t.created_at DESC LIMIT 300", [userId])
        );
        const done = tasks.filter((t: any) => /complete|done/i.test(String(t.status))).length;
        const open = tasks.filter((t: any) => !/complete|done|cancel/i.test(String(t.status))).length;
        const targets = await safe(queryDB("SELECT id, title, period, status FROM targets WHERE user_id = ? ORDER BY created_at DESC LIMIT 3", [userId]));
        boxes.push({
          key: "tasks",
          title: "Tasks & Targets",
          sub: `Tasks: ${tasks.length} · ${done} done · ${open} open`,
          rows: [
            ...tasks.filter((t: any) => !/complete|done|cancel/i.test(String(t.status))).slice(0, 3).map((t: any) => ({ label: t.title, value: t.due_date ? `due ${dhakaDay(t.due_date)}` : "", status: t.status })),
            ...targets.map((t: any) => ({ label: `Target: ${t.title}`, value: t.period || "", status: t.status }))
          ],
          link: "/admin/task-management"
        });
      }
      if (has(mods, "exit_offboarding") && userId) {
        const exits = await safe(queryDB("SELECT id, exit_type, status, last_working_day FROM exit_requests WHERE user_id = ? ORDER BY id DESC LIMIT 3", [userId]));
        const fs = await safe(queryDB("SELECT id, status, net_payable, paid_at FROM final_settlements WHERE user_id = ? ORDER BY id DESC LIMIT 3", [userId]));
        boxes.push({
          key: "exit",
          title: "Exit & Final Settlement",
          sub: exits.length ? "" : "Still working here",
          rows: [
            ...exits.map((x: any) => ({ label: `Exit: ${x.exit_type || "exit"}`, value: x.last_working_day ? `last day ${dhakaDay(x.last_working_day)}` : "", status: x.status })),
            ...fs.map((s: any) => ({ label: "Final settlement", value: pay ? money(s.net_payable) : "", status: s.paid_at ? "paid" : s.status }))
          ],
          link: "/admin/exit-offboarding"
        });
      }
      res.json({ boxes });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Login & Access ----
  app.get("/api/hr-ops/p360/:employeeId/access-log", ...gate, requireModuleLayer("hr_operations", "p360_access"), async (req: any, res: any) => {
    try {
      const e = await employeeOf(req, res);
      if (!e) return;
      const userId = e.user_id ? Number(e.user_id) : null;
      const logs = await logRows(userId, Number(e.id));
      const rows = logs.map((r: any) => ({
        id: Number(r.id),
        at: iso(r.created_at),
        by: r.actor_name || null,
        source: r.source,
        action: r.action,
        changes: (parse(r.changes_json) as any[]).map((c) => ({ what: String(c.what || ""), text: changeText(c), added: c.added || [], removed: c.removed || [], from: c.from ?? null, to: c.to ?? null }))
      }));
      const older = (await olderAudit(userId)).map((o, i) => ({
        id: -(i + 1),
        at: o.at,
        by: o.by,
        source: "older",
        action: o.action,
        changes: o.changes.map((c: any) => ({ what: c.what, text: changeText(c), added: [], removed: [], from: null, to: c.to ?? null }))
      }));
      const first = (await safe(queryDB("/*unscoped*/ SELECT MIN(created_at) AS at FROM user_access_log")))[0];
      const u = userId ? (await safe(queryDB("/*unscoped*/ SELECT created_at, role, username, email FROM users WHERE id = ?", [userId])))[0] : null;
      res.json({
        has_login: !!userId,
        login_created_at: u ? iso(u.created_at) : null,
        login_id: u ? u.username || u.email || null : null,
        recording_since: iso(first?.at) || null,
        rows: [...rows, ...older]
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
