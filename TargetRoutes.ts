/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Targets — monthly / yearly targets per Employee, each with several tasks,
// followed to a deadline.
//
//   A supervisor (department head — departments.supervisor_user_id — or the
//   Employee's supervisor in employee_supervisors) gives targets to the
//   people under them from Self Service -> My Targets -> Team (one person or
//   the whole team at once: everyone gets their own copy). An Employee can
//   share their own target too; that one waits for their supervisor's
//   approval (straight to active when they have no supervisor).
//
//   draft -> (share) -> pending (self, waits for the supervisor) -> active
//                    -> active (given by the supervisor)
//   pending -> rejected (with a reason)
//   active  -> closed (the period is over; nothing changes after that)
//   pending / active -> cancelled (supervisor, or Target Reports'
//                       "Cancel targets" layer, with a reason)
//
//   Once shared a target is locked: no editing and no deleting, of the target
//   or its tasks. Only a task's progress (0–100 %) and status change, with a
//   note and an optional file, by the Employee or their supervisor; every
//   change is kept (target_task_updates). A cancelled / rejected / closed
//   target can be copied into a new draft.
//
//   Self Service -> My Targets is an off-by-default per-account switch
//   (users.can_view_targets, Module Access). Admin Panel -> Target Reports is
//   the "target_reports" module: "read" = the report, "target_export" =
//   Excel / PDF, "target_cancel" = cancel / close anyone's target (both
//   explicit-only). Superadmin always.
//
//   Reminders: 3 days before the deadline and on the day (to the Employee),
//   the day after it if still not 100 % (to the Employee and the
//   supervisors); supervisors get one evening digest of the day's updates.
//
// targets carries company_id (companyScope.ts OWN_TABLES); target_tasks /
// target_task_updates hang off it (LINKED_TABLES).

import type { Express } from "express";
import type { AlertType } from "./Alerts";
import { runsBackgroundJobs } from "./jobRunner";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface TargetRouteDeps {
  authenticateToken: any;
  queryDB: QueryDB;
  hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
  createAlert: (
    queryDB: QueryDB,
    params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }
  ) => Promise<void>;
}

export const TARGET_STATUSES = ["draft", "pending", "active", "rejected", "cancelled", "closed"] as const;
export const TARGET_TASK_STATUSES = ["not_started", "in_progress", "completed", "blocked"] as const;
const MAX_TASKS = 30;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;

export async function ensureTargetSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  const run = async (label: string, sql: string) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      console.warn(`⚠️ Could not ensure ${label}: ` + err.message);
    }
  };
  await run(
    "targets table",
    `CREATE TABLE IF NOT EXISTS targets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      user_id INT NOT NULL,
      department VARCHAR(150) NULL,
      department_id INT NULL,
      period_type VARCHAR(10) NOT NULL,
      period VARCHAR(7) NOT NULL,
      title VARCHAR(200) NOT NULL,
      deadline DATE NOT NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'draft',
      source VARCHAR(12) NOT NULL DEFAULT 'supervisor',
      created_by INT NOT NULL,
      shared_at DATETIME NULL,
      approved_by INT NULL,
      approved_at DATETIME NULL,
      rejected_by INT NULL,
      rejected_at DATETIME NULL,
      reject_reason TEXT NULL,
      cancelled_by INT NULL,
      cancelled_at DATETIME NULL,
      cancel_reason TEXT NULL,
      closed_by INT NULL,
      closed_at DATETIME NULL,
      copied_from INT NULL,
      reminder_stage VARCHAR(10) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_targets_company (company_id),
      INDEX idx_targets_user (user_id),
      INDEX idx_targets_period (period_type, period),
      INDEX idx_targets_status (status)
    )`
  );
  await run(
    "target_tasks table",
    `CREATE TABLE IF NOT EXISTS target_tasks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      target_id INT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      title VARCHAR(200) NOT NULL,
      description TEXT NULL,
      due_date DATE NULL,
      weight INT NOT NULL DEFAULT 1,
      progress INT NOT NULL DEFAULT 0,
      status VARCHAR(12) NOT NULL DEFAULT 'not_started',
      completed_at DATETIME NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE,
      INDEX idx_target_tasks_target (target_id)
    )`
  );
  await run(
    "target_task_updates table",
    `CREATE TABLE IF NOT EXISTS target_task_updates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      task_id INT NOT NULL,
      user_id INT NOT NULL,
      from_progress INT NOT NULL DEFAULT 0,
      to_progress INT NOT NULL DEFAULT 0,
      from_status VARCHAR(12) NULL,
      to_status VARCHAR(12) NULL,
      note TEXT NULL,
      file_name VARCHAR(255) NULL,
      file_mime VARCHAR(120) NULL,
      file_data LONGBLOB NULL,
      digested TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES target_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_target_updates_task (task_id)
    )`
  );
}

// ---- small helpers (exported for tests) ----------------------------------
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const ymd = (v: any): string | null => {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  const s = String(v).slice(0, 10);
  return DATE_RE.test(s) ? s : null;
};
export const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
// Last day of a period: "2026-10" -> 2026-10-31, "2026" -> 2026-12-31.
export function periodEnd(periodType: string, period: string): string {
  if (periodType === "yearly") return `${period}-12-31`;
  const [y, m] = period.split("-").map(Number);
  return `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}
export const periodStart = (periodType: string, period: string) => (periodType === "yearly" ? `${period}-01-01` : `${period}-01`);
// Weighted average of the tasks' progress, whole percent.
export function targetProgress(tasks: { progress: number; weight: number }[]): number {
  const total = tasks.reduce((s, t) => s + Math.max(1, Number(t.weight) || 1), 0);
  if (!total) return 0;
  const sum = tasks.reduce((s, t) => s + Math.max(1, Number(t.weight) || 1) * Math.min(100, Math.max(0, Number(t.progress) || 0)), 0);
  return Math.round(sum / total);
}
// The status a task ends up with after an update.
export function nextTaskState(progress: number, status: string | null | undefined): { progress: number; status: string } {
  let p = Math.min(100, Math.max(0, Math.round(Number(progress) || 0)));
  let s = TARGET_TASK_STATUSES.includes(status as any) ? String(status) : "";
  if (s === "completed") p = 100;
  if (p === 100) s = "completed";
  else if (s === "completed") s = "in_progress";
  if (!s) s = p > 0 ? "in_progress" : "not_started";
  if (s === "not_started" && p > 0) s = "in_progress";
  return { progress: p, status: s };
}
// Which reminder is due today for an active target (null = none).
export function reminderStageFor(deadline: string, now: string, progress: number, sent: string | null): "d3" | "d0" | "over" | null {
  if (progress >= 100) return null;
  const order = ["d3", "d0", "over"];
  const done = sent ? order.indexOf(sent) : -1;
  let stage: "d3" | "d0" | "over" | null = null;
  if (now > deadline) stage = "over";
  else if (now === deadline) stage = "d0";
  else if (now >= addDays(deadline, -3)) stage = "d3";
  if (!stage || order.indexOf(stage) <= done) return null;
  return stage;
}

const str = (v: any, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const idList = (v: any): number[] =>
  Array.from(new Set<number>((Array.isArray(v) ? v : []).map(Number).filter((n: number) => Number.isFinite(n) && n > 0)));
const placeholders = (n: number) => Array(n).fill("?").join(", ");
const bad = (message: string, status = 400) => Object.assign(new Error(message), { status });

export function registerTargetRoutes(app: Express, deps: TargetRouteDeps) {
  const { authenticateToken, queryDB, hasModuleLayer, createAlert } = deps;
  const rows = async (sql: string, params: any[] = []): Promise<any[]> => ((await queryDB(sql, params)) as any[]) || [];

  // ---- who may do what -------------------------------------------------
  const isSuper = (user: any) => user?.role === "superadmin";
  async function hasSelf(user: any): Promise<boolean> {
    if (!user || user.onb) return false;
    if (isSuper(user)) return true;
    const r = await rows("SELECT can_view_targets FROM users WHERE id = ?", [user.id]);
    return !!Number(r[0]?.can_view_targets || 0);
  }
  const reportsRead = (user: any) => hasModuleLayer(user, "target_reports", "read");
  const canCancelAny = (user: any) => hasModuleLayer(user, "target_reports", "target_cancel");

  async function employeeOf(userId: number): Promise<any | null> {
    return (await rows("SELECT id, employee_id, name, designation, department, department_id, user_id FROM all_employees WHERE user_id = ?", [userId]))[0] || null;
  }

  // Accounts under this one: the people of the departments they head, and the
  // Employees whose supervisor (employee_supervisors) they are.
  async function teamOf(userId: number): Promise<Map<number, any>> {
    const out = new Map<number, any>();
    const emps = await rows(
      "SELECT id, employee_id, name, designation, department, department_id, user_id FROM all_employees WHERE user_id IS NOT NULL AND is_active = 1"
    );
    const depts = await rows("SELECT id, name FROM departments WHERE supervisor_user_id = ? AND is_active = 1", [userId]);
    const ids = new Set(depts.map((d) => Number(d.id)));
    const names = new Set(depts.map((d) => String(d.name).toLowerCase()));
    for (const e of emps) {
      if ((e.department_id && ids.has(Number(e.department_id))) || (e.department && names.has(String(e.department).toLowerCase()))) out.set(Number(e.user_id), e);
    }
    const me = emps.find((e) => Number(e.user_id) === Number(userId)) || (await employeeOf(userId));
    if (me) {
      const reports = await rows("SELECT employee_id FROM employee_supervisors WHERE supervisor_id = ?", [me.id]);
      const reportIds = new Set(reports.map((r) => Number(r.employee_id)));
      for (const e of emps) if (reportIds.has(Number(e.id))) out.set(Number(e.user_id), e);
    }
    out.delete(Number(userId));
    return out;
  }

  // The accounts that supervise this one (direct supervisor first).
  async function supervisorsOf(userId: number): Promise<number[]> {
    const out: number[] = [];
    const emp = await employeeOf(userId);
    if (!emp) return out;
    const sup = await rows(
      `SELECT s.is_direct, e.user_id FROM employee_supervisors s JOIN all_employees e ON e.id = s.supervisor_id
        WHERE s.employee_id = ? AND e.user_id IS NOT NULL ORDER BY s.is_direct DESC, s.id`,
      [emp.id]
    );
    for (const s of sup) out.push(Number(s.user_id));
    const heads = await rows(
      "SELECT supervisor_user_id FROM departments WHERE supervisor_user_id IS NOT NULL AND is_active = 1 AND (id = ? OR LOWER(name) = LOWER(?))",
      [emp.department_id || 0, emp.department || ""]
    );
    for (const h of heads) out.push(Number(h.supervisor_user_id));
    return Array.from(new Set(out.filter((id) => id && id !== Number(userId))));
  }

  async function notify(userIds: number[], title: string, message: string, targetId: number, exceptUserId?: number) {
    for (const uid of new Set(userIds.map(Number))) {
      if (!uid || uid === Number(exceptUserId)) continue;
      try {
        await createAlert(queryDB, { userId: uid, type: "target", title, message, relatedType: "target", relatedId: targetId });
      } catch (err: any) {
        console.warn("⚠️ Could not send target alert: " + err.message);
      }
    }
  }

  // ---- reading -----------------------------------------------------------
  async function loadTargets(where = "", params: any[] = [], withUpdates = false): Promise<any[]> {
    const ts = await rows(`SELECT * FROM targets ${where}`, params);
    if (!ts.length) return [];
    const tIds = ts.map((t) => Number(t.id));
    const tasks = await rows(`SELECT * FROM target_tasks WHERE target_id IN (${placeholders(tIds.length)}) ORDER BY sort_order, id`, tIds);
    const updates = withUpdates && tasks.length
      ? await rows(
          `SELECT id, task_id, user_id, from_progress, to_progress, from_status, to_status, note, file_name, (file_data IS NOT NULL) AS has_file, created_at
             FROM target_task_updates WHERE task_id IN (${placeholders(tasks.length)}) ORDER BY id`,
          tasks.map((k) => Number(k.id))
        )
      : [];
    const userIds = new Set<number>();
    for (const t of ts) for (const k of ["user_id", "created_by", "approved_by", "rejected_by", "cancelled_by", "closed_by"]) if (t[k]) userIds.add(Number(t[k]));
    for (const u of updates) userIds.add(Number(u.user_id));
    const ids = [...userIds];
    const users = ids.length ? await rows(`SELECT id, name FROM users WHERE id IN (${placeholders(ids.length)})`, ids) : [];
    const emps = ids.length ? await rows(`SELECT user_id, name, employee_id, designation, department FROM all_employees WHERE user_id IN (${placeholders(ids.length)})`, ids) : [];
    const nameOf = new Map<number, string>(users.map((u) => [Number(u.id), String(u.name)]));
    const empOf = new Map<number, any>(emps.map((e) => [Number(e.user_id), e]));
    for (const e of emps) if (e.name) nameOf.set(Number(e.user_id), String(e.name));
    const name = (id: any) => (id ? nameOf.get(Number(id)) || null : null);
    const now = today();
    const byTarget = new Map<number, any[]>();
    for (const k of tasks) {
      const tid = Number(k.target_id);
      if (!byTarget.has(tid)) byTarget.set(tid, []);
      byTarget.get(tid)!.push(k);
    }
    const updByTask = new Map<number, any[]>();
    for (const u of updates) {
      const kid = Number(u.task_id);
      if (!updByTask.has(kid)) updByTask.set(kid, []);
      updByTask.get(kid)!.push({
        id: Number(u.id),
        user_id: Number(u.user_id),
        user_name: name(u.user_id) || "Unknown",
        from_progress: Number(u.from_progress),
        to_progress: Number(u.to_progress),
        from_status: u.from_status || null,
        to_status: u.to_status || null,
        note: u.note || "",
        file_name: u.file_name || null,
        has_file: !!Number(u.has_file),
        created_at: u.created_at
      });
    }
    return ts.map((t) => {
      const deadline = ymd(t.deadline)!;
      const list = (byTarget.get(Number(t.id)) || []).map((k) => {
        const due = ymd(k.due_date);
        const doneDay = ymd(k.completed_at);
        const limit = due || deadline;
        return {
          id: Number(k.id),
          title: k.title,
          description: k.description || "",
          due_date: due,
          weight: Number(k.weight) || 1,
          progress: Number(k.progress) || 0,
          status: k.status,
          completed_at: k.completed_at || null,
          late: k.status === "completed" ? !!doneDay && doneDay > limit : t.status === "active" && now > limit,
          ...(withUpdates ? { updates: updByTask.get(Number(k.id)) || [] } : {})
        };
      });
      const progress = targetProgress(list);
      const owner = empOf.get(Number(t.user_id));
      return {
        id: Number(t.id),
        user_id: Number(t.user_id),
        owner_name: name(t.user_id) || "Unknown",
        employee_code: owner?.employee_id || null,
        designation: owner?.designation || null,
        department: t.department || owner?.department || null,
        period_type: t.period_type,
        period: t.period,
        title: t.title,
        deadline,
        status: t.status,
        source: t.source,
        created_by: Number(t.created_by),
        created_by_name: name(t.created_by),
        shared_at: t.shared_at || null,
        approved_by_name: name(t.approved_by),
        approved_at: t.approved_at || null,
        rejected_by_name: name(t.rejected_by),
        reject_reason: t.reject_reason || null,
        cancelled_by_name: name(t.cancelled_by),
        cancelled_at: t.cancelled_at || null,
        cancel_reason: t.cancel_reason || null,
        closed_by_name: name(t.closed_by),
        closed_at: t.closed_at || null,
        copied_from: t.copied_from ? Number(t.copied_from) : null,
        created_at: t.created_at,
        progress,
        task_count: list.length,
        completed_count: list.filter((k) => k.status === "completed").length,
        in_progress_count: list.filter((k) => k.status === "in_progress").length,
        not_started_count: list.filter((k) => k.status === "not_started").length,
        blocked_count: list.filter((k) => k.status === "blocked").length,
        overdue: t.status === "active" && progress < 100 && now > deadline,
        tasks: list
      };
    });
  }
  const oneTarget = async (id: number, withUpdates = true) => (await loadTargets("WHERE id = ?", [id], withUpdates))[0] || null;
  const summary = (t: any) => {
    const { tasks, ...rest } = t;
    return { ...rest, tasks: tasks.map(({ updates, description, ...k }: any) => k) };
  };

  async function rightsFor(t: any, user: any) {
    const uid = Number(user.id);
    const sa = isSuper(user);
    const self = await hasSelf(user);
    const isOwner = t.user_id === uid;
    const isCreator = t.created_by === uid;
    const isSup = self && (sa || (await teamOf(uid)).has(t.user_id)) && !isOwner;
    const admin = sa || (await reportsRead(user));
    const cancelAny = sa || (await canCancelAny(user));
    const draft = t.status === "draft";
    const live = t.status === "active";
    return {
      see: draft ? isCreator : (self && (isOwner || isCreator || isSup)) || admin,
      edit: draft && isCreator && self,
      delete: draft && isCreator && self,
      share: draft && isCreator && self,
      approve: t.status === "pending" && (isSup || sa),
      update: live && self && (isOwner || isSup),
      cancel: (t.status === "pending" || live) && (isSup || cancelAny),
      close: live && (isSup || cancelAny),
      copy: ["rejected", "cancelled", "closed"].includes(t.status) && self && (isOwner || isSup)
    };
  }

  // ---- writing helpers -----------------------------------------------------
  function cleanTasks(input: any): { title: string; description: string | null; due_date: string | null; weight: number }[] {
    const list = Array.isArray(input) ? input : [];
    const out = [];
    for (const raw of list) {
      const title = str(raw?.title, 200);
      if (!title) continue;
      const due = raw?.due_date ? ymd(raw.due_date) : null;
      if (raw?.due_date && !due) throw bad(`Task "${title}": date must be YYYY-MM-DD.`);
      const weight = Math.round(Number(raw?.weight) || 1);
      out.push({ title, description: str(raw?.description, 2000) || null, due_date: due, weight: Math.min(100, Math.max(1, weight)) });
    }
    if (!out.length) throw bad("Add at least one task.");
    if (out.length > MAX_TASKS) throw bad(`At most ${MAX_TASKS} tasks in one target.`);
    return out;
  }
  function cleanHead(body: any) {
    const periodType = body?.period_type === "yearly" ? "yearly" : body?.period_type === "monthly" ? "monthly" : "";
    if (!periodType) throw bad("Pick Monthly or Yearly.");
    const period = String(body?.period || "");
    if (periodType === "monthly" ? !MONTH_RE.test(period) : !YEAR_RE.test(period)) throw bad(periodType === "monthly" ? "Month must be YYYY-MM." : "Year must be YYYY.");
    const deadline = body?.deadline ? ymd(body.deadline) : periodEnd(periodType, period);
    if (!deadline) throw bad("Deadline must be YYYY-MM-DD.");
    if (deadline < periodStart(periodType, period)) throw bad("Deadline can't be before the period starts.");
    const label = periodType === "monthly" ? new Date(`${period}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }) : period;
    const title = str(body?.title, 200) || `${label} target`;
    return { periodType, period, deadline, title };
  }
  async function insertTasks(targetId: number, tasks: ReturnType<typeof cleanTasks>) {
    let i = 0;
    for (const k of tasks) {
      await queryDB("INSERT INTO target_tasks (target_id, sort_order, title, description, due_date, weight) VALUES (?, ?, ?, ?, ?, ?)", [
        targetId,
        i++,
        k.title,
        k.description,
        k.due_date,
        k.weight
      ]);
    }
  }
  async function insertTarget(ownerId: number, head: ReturnType<typeof cleanHead>, createdBy: number, copiedFrom: number | null = null): Promise<number> {
    const emp = await employeeOf(ownerId);
    const r: any = await queryDB(
      "INSERT INTO targets (user_id, department, department_id, period_type, period, title, deadline, status, source, created_by, copied_from) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)",
      [ownerId, emp?.department || null, emp?.department_id || null, head.periodType, head.period, head.title, head.deadline, ownerId === createdBy ? "self" : "supervisor", createdBy, copiedFrom]
    );
    return Number(r.insertId);
  }

  // draft -> pending / active, and the alerts that go with it.
  async function share(targetId: number, user: any): Promise<string> {
    const t = await oneTarget(targetId, false);
    if (!t) throw bad("Target not found.", 404);
    if (t.status !== "draft") throw bad("This target has already been shared.");
    if (t.created_by !== Number(user.id)) throw bad("Only the person who made this draft can share it.", 403);
    if (!t.task_count) throw bad("Add at least one task before sharing.");
    const self = t.user_id === Number(user.id);
    const sups = self ? await supervisorsOf(t.user_id) : [];
    const status = self && sups.length ? "pending" : "active";
    const claim: any = await queryDB(
      `UPDATE targets SET status = ?, shared_at = NOW()${status === "active" && self ? ", approved_at = NOW()" : ""} WHERE id = ? AND status = 'draft'`,
      [status, targetId]
    );
    if (claim && claim.affectedRows === 0) throw bad("This target has already been shared.");
    const what = `${t.title} (${t.task_count} task${t.task_count === 1 ? "" : "s"}, deadline ${t.deadline})`;
    if (status === "pending") await notify(sups, "Target waiting for your approval", `${t.owner_name} shared a target: ${what}.`, targetId, user.id);
    else if (!self) await notify([t.user_id], "New target for you", `${user.name || t.created_by_name || "Your supervisor"} gave you a target: ${what}.`, targetId, user.id);
    return status;
  }

  async function guard(req: any, res: any, fn: () => Promise<any>) {
    try {
      await fn();
    } catch (err: any) {
      if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
    }
  }
  async function needSelf(req: any) {
    if (!(await hasSelf(req.user))) throw bad("My Targets isn't turned on for your account.", 403);
  }
  async function loadWithRights(req: any) {
    const t = await oneTarget(Number(req.params.id));
    if (!t) throw bad("Target not found.", 404);
    const rights = await rightsFor(t, req.user);
    if (!rights.see) throw bad("You can't see this target.", 403);
    return { t, rights };
  }

  // ---- routes: Self Service ----------------------------------------------
  app.get("/api/targets/access", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      const self = await hasSelf(req.user);
      const team = self ? await teamOf(Number(req.user.id)) : new Map();
      res.json({
        enabled: self,
        supervisor: self && team.size > 0,
        team_size: team.size,
        reports: isSuper(req.user) || (await reportsRead(req.user)),
        today: today()
      });
    })
  );

  // My own targets (not someone else's draft for me).
  app.get("/api/targets/mine", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      await needSelf(req);
      const uid = Number(req.user.id);
      const list = await loadTargets("WHERE user_id = ? AND (status <> 'draft' OR created_by = ?) ORDER BY period DESC, id DESC", [uid, uid]);
      res.json(list.map(summary));
    })
  );

  // The people under me, with their targets, and what waits for my approval.
  app.get("/api/targets/team", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      await needSelf(req);
      const uid = Number(req.user.id);
      const team = await teamOf(uid);
      const ids = [...team.keys()];
      const list = ids.length
        ? await loadTargets(`WHERE user_id IN (${placeholders(ids.length)}) AND (status <> 'draft' OR created_by = ?) ORDER BY period DESC, id DESC`, [...ids, uid])
        : [];
      const access = ids.length ? await rows(`SELECT id, role, can_view_targets FROM users WHERE id IN (${placeholders(ids.length)})`, ids) : [];
      const hasAccess = new Map<number, boolean>(access.map((u) => [Number(u.id), u.role === "superadmin" || !!Number(u.can_view_targets || 0)]));
      const members = [...team.values()]
        .map((e) => ({
          user_id: Number(e.user_id),
          name: e.name,
          employee_code: e.employee_id || null,
          designation: e.designation || null,
          department: e.department || null,
          has_access: hasAccess.get(Number(e.user_id)) || false
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      res.json({ members, targets: list.map(summary), pending: list.filter((t) => t.status === "pending").map(summary) });
    })
  );

  app.get("/api/targets/:id(\\d+)", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      const { t, rights } = await loadWithRights(req);
      res.json({ ...t, rights });
    })
  );

  // New target(s): for me, or for people under me (one copy each). share=true
  // shares straight away.
  app.post("/api/targets", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      await needSelf(req);
      const uid = Number(req.user.id);
      const head = cleanHead(req.body);
      const tasks = cleanTasks(req.body?.tasks);
      let owners = idList(req.body?.owner_ids);
      if (!owners.length) owners = [uid];
      const others = owners.filter((o) => o !== uid);
      if (others.length) {
        const team = await teamOf(uid);
        const outside = others.filter((o) => !team.has(o));
        if (outside.length && !isSuper(req.user)) throw bad("You can only give targets to people under you.", 403);
        if (isSuper(req.user) && outside.length) {
          const known = await rows(`SELECT id FROM users WHERE id IN (${placeholders(outside.length)})`, outside);
          if (known.length !== outside.length) throw bad("Someone you picked wasn't found.");
        }
      }
      const created: { id: number; status: string }[] = [];
      for (const owner of owners) {
        const id = await insertTarget(owner, head, uid);
        await insertTasks(id, tasks);
        created.push({ id, status: req.body?.share ? await share(id, req.user) : "draft" });
      }
      res.status(201).json({ created });
    })
  );

  // Change a draft (title, period, deadline, tasks). Drafts only.
  app.put("/api/targets/:id(\\d+)", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      await needSelf(req);
      const { t, rights } = await loadWithRights(req);
      if (!rights.edit) throw bad(t.status === "draft" ? "Only the person who made this draft can change it." : "A shared target can't be changed — only its tasks' progress and status.", 403);
      const head = cleanHead(req.body);
      const tasks = cleanTasks(req.body?.tasks);
      const r: any = await queryDB("UPDATE targets SET period_type = ?, period = ?, title = ?, deadline = ? WHERE id = ? AND status = 'draft'", [
        head.periodType,
        head.period,
        head.title,
        head.deadline,
        t.id
      ]);
      if (r && r.affectedRows === 0) throw bad("This target has already been shared.");
      await queryDB("DELETE FROM target_tasks WHERE target_id = ?", [t.id]);
      await insertTasks(t.id, tasks);
      let status = "draft";
      if (req.body?.share) status = await share(t.id, req.user);
      res.json({ id: t.id, status });
    })
  );

  app.delete("/api/targets/:id(\\d+)", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      await needSelf(req);
      const { t, rights } = await loadWithRights(req);
      if (!rights.delete) throw bad(t.status === "draft" ? "Only the person who made this draft can delete it." : "A shared target can't be deleted.", 403);
      const r: any = await queryDB("DELETE FROM targets WHERE id = ? AND status = 'draft'", [t.id]);
      if (r && r.affectedRows === 0) throw bad("A shared target can't be deleted.");
      res.json({ success: true });
    })
  );

  app.post("/api/targets/:id(\\d+)/share", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      await needSelf(req);
      const { rights } = await loadWithRights(req);
      if (!rights.share) throw bad("You can't share this target.", 403);
      res.json({ status: await share(Number(req.params.id), req.user) });
    })
  );

  app.post("/api/targets/:id(\\d+)/approve", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      const { t, rights } = await loadWithRights(req);
      if (!rights.approve) throw bad("Only this person's supervisor can approve it.", 403);
      const r: any = await queryDB("UPDATE targets SET status = 'active', approved_by = ?, approved_at = NOW() WHERE id = ? AND status = 'pending'", [req.user.id, t.id]);
      if (r && r.affectedRows === 0) throw bad("This target isn't waiting for approval any more.");
      await notify([t.user_id], "Target approved", `${req.user.name || "Your supervisor"} approved your target "${t.title}". You can start updating its tasks.`, t.id, req.user.id);
      res.json({ status: "active" });
    })
  );

  app.post("/api/targets/:id(\\d+)/reject", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      const { t, rights } = await loadWithRights(req);
      if (!rights.approve) throw bad("Only this person's supervisor can reject it.", 403);
      const reason = str(req.body?.reason, 1000);
      if (!reason) throw bad("Write why it is rejected.");
      const r: any = await queryDB("UPDATE targets SET status = 'rejected', rejected_by = ?, rejected_at = NOW(), reject_reason = ? WHERE id = ? AND status = 'pending'", [
        req.user.id,
        reason,
        t.id
      ]);
      if (r && r.affectedRows === 0) throw bad("This target isn't waiting for approval any more.");
      await notify([t.user_id], "Target rejected", `${req.user.name || "Your supervisor"} rejected your target "${t.title}": ${reason}. You can copy it into a new one.`, t.id, req.user.id);
      res.json({ status: "rejected" });
    })
  );

  app.post("/api/targets/:id(\\d+)/cancel", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      const { t, rights } = await loadWithRights(req);
      if (!rights.cancel) throw bad("You can't cancel this target.", 403);
      const reason = str(req.body?.reason, 1000);
      if (!reason) throw bad("Write why it is cancelled.");
      const r: any = await queryDB(
        "UPDATE targets SET status = 'cancelled', cancelled_by = ?, cancelled_at = NOW(), cancel_reason = ? WHERE id = ? AND status IN ('pending', 'active')",
        [req.user.id, reason, t.id]
      );
      if (r && r.affectedRows === 0) throw bad("This target can't be cancelled any more.");
      await notify([t.user_id, t.created_by], "Target cancelled", `${req.user.name || "Someone"} cancelled the target "${t.title}": ${reason}.`, t.id, req.user.id);
      res.json({ status: "cancelled" });
    })
  );

  app.post("/api/targets/:id(\\d+)/close", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      const { t, rights } = await loadWithRights(req);
      if (!rights.close) throw bad("You can't close this target.", 403);
      const r: any = await queryDB("UPDATE targets SET status = 'closed', closed_by = ?, closed_at = NOW() WHERE id = ? AND status = 'active'", [req.user.id, t.id]);
      if (r && r.affectedRows === 0) throw bad("This target isn't active any more.");
      await notify([t.user_id], "Target closed", `"${t.title}" was closed at ${t.progress}% (${t.completed_count} of ${t.task_count} tasks done).`, t.id, req.user.id);
      res.json({ status: "closed" });
    })
  );

  // A rejected / cancelled / closed target as a new draft (progress reset).
  app.post("/api/targets/:id(\\d+)/copy", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      await needSelf(req);
      const { t, rights } = await loadWithRights(req);
      if (!rights.copy) throw bad("You can't copy this target.", 403);
      const id = await insertTarget(t.user_id, { periodType: t.period_type, period: t.period, deadline: t.deadline, title: t.title }, Number(req.user.id), t.id);
      await insertTasks(
        id,
        t.tasks.map((k: any) => ({ title: k.title, description: k.description || null, due_date: k.due_date, weight: k.weight }))
      );
      res.status(201).json({ id, status: "draft" });
    })
  );

  // Progress / status of one task, with a note and an optional file.
  app.post("/api/target-tasks/:id(\\d+)/update", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      const task = (await rows("SELECT * FROM target_tasks WHERE id = ?", [Number(req.params.id)]))[0];
      if (!task) throw bad("Task not found.", 404);
      req.params.id = String(task.target_id);
      const { t, rights } = await loadWithRights(req);
      if (!rights.update) {
        throw bad(t.status === "pending" ? "This target is waiting for your supervisor's approval." : t.status === "active" ? "You can't update this target." : "This target is no longer active.", 403);
      }
      const next = nextTaskState(req.body?.progress ?? task.progress, req.body?.status);
      const note = str(req.body?.note, 3000);
      let file: { name: string; mime: string; data: Buffer } | null = null;
      if (req.body?.file_base64) {
        const data = Buffer.from(String(req.body.file_base64), "base64");
        if (!data.length) throw bad("The file is empty.");
        if (data.length > MAX_FILE_BYTES) throw bad("The file is larger than 5 MB.");
        file = { name: str(req.body?.file_name, 255) || "file", mime: str(req.body?.file_mime, 120) || "application/octet-stream", data };
      }
      if (next.progress === Number(task.progress) && next.status === task.status && !note && !file) throw bad("Nothing changed — move the progress, change the status or write a note.");
      await queryDB("UPDATE target_tasks SET progress = ?, status = ?, completed_at = ? WHERE id = ?", [
        next.progress,
        next.status,
        next.status === "completed" ? task.completed_at || new Date() : null,
        task.id
      ]);
      await queryDB(
        "INSERT INTO target_task_updates (task_id, user_id, from_progress, to_progress, from_status, to_status, note, file_name, file_mime, file_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [task.id, req.user.id, Number(task.progress), next.progress, task.status, next.status, note || null, file?.name || null, file?.mime || null, file?.data || null]
      );
      // The supervisor updating it: tell the Employee now (the Employee's own
      // updates reach the supervisor in the evening digest).
      if (Number(req.user.id) !== t.user_id) {
        await notify([t.user_id], "Target task updated", `${req.user.name || "Your supervisor"} set "${task.title}" to ${next.progress}%${note ? `: ${note.slice(0, 120)}` : "."}`, t.id, req.user.id);
      }
      res.json(await oneTarget(t.id));
    })
  );

  app.get("/api/target-updates/:id(\\d+)/file", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      const u = (await rows("SELECT u.file_name, u.file_mime, u.file_data, k.target_id FROM target_task_updates u JOIN target_tasks k ON k.id = u.task_id WHERE u.id = ?", [Number(req.params.id)]))[0];
      if (!u || !u.file_data) throw bad("No file.", 404);
      req.params.id = String(u.target_id);
      await loadWithRights(req);
      const buf: Buffer = Buffer.isBuffer(u.file_data) ? u.file_data : Buffer.from(u.file_data);
      res.setHeader("Content-Type", u.file_mime || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${String(u.file_name || "file").replace(/["\r\n]/g, "")}"`);
      res.send(buf);
    })
  );

  // ---- routes: Admin Panel -> Target Reports -------------------------------
  async function reportTargets(q: any) {
    const periodType = q.period_type === "yearly" ? "yearly" : q.period_type === "monthly" ? "monthly" : "";
    const year = YEAR_RE.test(String(q.year || "")) ? String(q.year) : today().slice(0, 4);
    const month = MONTH_RE.test(String(q.month || "")) ? String(q.month) : "";
    const where: string[] = ["status <> 'draft'"];
    const params: any[] = [];
    if (periodType === "monthly") {
      where.push("period_type = 'monthly'");
      if (month) {
        where.push("period = ?");
        params.push(month);
      } else {
        where.push("period LIKE ?");
        params.push(`${year}-%`);
      }
    } else if (periodType === "yearly") {
      where.push("period_type = 'yearly' AND period = ?");
      params.push(year);
    } else {
      // The whole year: the yearly targets and every month of it.
      where.push("(period = ? OR period LIKE ?)");
      params.push(year, `${year}-%`);
    }
    if (TARGET_STATUSES.includes(q.status)) {
      where.push("status = ?");
      params.push(q.status);
    }
    const uid = Number(q.user_id);
    if (uid > 0) {
      where.push("user_id = ?");
      params.push(uid);
    }
    let list = await loadTargets(`WHERE ${where.join(" AND ")} ORDER BY period DESC, id DESC`, params);
    if (q.department) list = list.filter((t) => String(t.department || "").toLowerCase() === String(q.department).toLowerCase());
    if (q.overdue === "1") list = list.filter((t) => t.overdue);
    const s = String(q.search || "").trim().toLowerCase();
    if (s) list = list.filter((t) => `${t.owner_name} ${t.employee_code || ""} ${t.title} ${t.tasks.map((k: any) => k.title).join(" ")}`.toLowerCase().includes(s));
    return { list, year, month, periodType };
  }
  const avg = (ns: number[]) => (ns.length ? Math.round(ns.reduce((a, b) => a + b, 0) / ns.length) : 0);
  // Cancelled / rejected targets are listed but left out of the averages.
  const counts = (ts: any[]) => {
    const live = ts.filter((t) => t.status === "active" || t.status === "closed" || t.status === "pending");
    const tasks = live.flatMap((t) => t.tasks);
    return {
      targets: ts.length,
      counted: live.length,
      avg_progress: avg(live.map((t) => t.progress)),
      tasks: tasks.length,
      completed_tasks: tasks.filter((k: any) => k.status === "completed").length,
      in_progress_tasks: tasks.filter((k: any) => k.status === "in_progress").length,
      not_started_tasks: tasks.filter((k: any) => k.status === "not_started").length,
      blocked_tasks: tasks.filter((k: any) => k.status === "blocked").length,
      late_tasks: tasks.filter((k: any) => k.late).length,
      overdue: ts.filter((t) => t.overdue).length,
      pending: ts.filter((t) => t.status === "pending").length,
      fully_done: live.filter((t) => t.progress >= 100).length
    };
  };

  app.get("/api/target-reports", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      if (!(await reportsRead(req.user))) throw bad("Target Reports access required.", 403);
      const { list, year, month, periodType } = await reportTargets(req.query);
      const groupBy = (key: (t: any) => string) => {
        const m = new Map<string, any[]>();
        for (const t of list) {
          const k = key(t);
          if (!m.has(k)) m.set(k, []);
          m.get(k)!.push(t);
        }
        return m;
      };
      const byDept = [...groupBy((t) => t.department || "—").entries()]
        .map(([department, ts]) => ({ department, people: new Set(ts.map((t) => t.user_id)).size, ...counts(ts) }))
        .sort((a, b) => a.department.localeCompare(b.department));
      const byEmp = [...groupBy((t) => String(t.user_id)).values()]
        .map((ts) => ({
          user_id: ts[0].user_id,
          name: ts[0].owner_name,
          employee_code: ts[0].employee_code,
          designation: ts[0].designation,
          department: ts[0].department,
          ...counts(ts)
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const depts = await rows("SELECT name FROM departments WHERE is_active = 1 ORDER BY name");
      const people = await rows("SELECT user_id, name, employee_id, department FROM all_employees WHERE user_id IS NOT NULL AND is_active = 1 ORDER BY name");
      res.json({
        year,
        month,
        period_type: periodType,
        summary: { ...counts(list), people: new Set(list.map((t) => t.user_id)).size },
        by_department: byDept,
        by_employee: byEmp,
        targets: list.map(summary),
        departments: depts.map((d) => d.name),
        people: people.map((p) => ({ user_id: Number(p.user_id), name: p.name, employee_code: p.employee_id || null, department: p.department || null })),
        can_export: isSuper(req.user) || (await hasModuleLayer(req.user, "target_reports", "target_export")),
        can_cancel: isSuper(req.user) || (await canCancelAny(req.user))
      });
    })
  );

  // Every task of the filtered targets, one row each — for Excel / PDF.
  app.get("/api/target-reports/export", authenticateToken, (req: any, res: any) =>
    guard(req, res, async () => {
      if (!(await hasModuleLayer(req.user, "target_reports", "target_export"))) throw bad("You don't have permission to export Target Reports.", 403);
      const { list } = await reportTargets(req.query);
      const out = [];
      for (const t of list) {
        for (const k of t.tasks) {
          out.push({
            target_id: t.id,
            employee: t.owner_name,
            employee_code: t.employee_code,
            designation: t.designation,
            department: t.department,
            period_type: t.period_type,
            period: t.period,
            target: t.title,
            deadline: t.deadline,
            target_status: t.status,
            target_progress: t.progress,
            overdue: t.overdue,
            task: k.title,
            task_due: k.due_date,
            weight: k.weight,
            task_progress: k.progress,
            task_status: k.status,
            completed_at: k.completed_at,
            late: k.late
          });
        }
      }
      res.json({ rows: out });
    })
  );

  // ---- scheduler: deadline reminders and the supervisors' evening digest ---
  // Runs outside any request, so every company's rows are seen.
  async function remind() {
    try {
      const hhmm = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka", hour12: false }).slice(0, 5);
      if (hhmm < "09:00") return;
      const now = today();
      const active = await loadTargets("WHERE status = 'active' AND deadline <= ?", [addDays(now, 3)]).catch(() => []);
      for (const t of active) {
        const sent = (await rows("SELECT reminder_stage FROM targets WHERE id = ?", [t.id]))[0]?.reminder_stage || null;
        const stage = reminderStageFor(t.deadline, now, t.progress, sent);
        if (!stage) continue;
        const claim: any = await queryDB("UPDATE targets SET reminder_stage = ? WHERE id = ? AND (reminder_stage <=> ?)", [stage, t.id, sent]);
        if (claim && claim.affectedRows === 0) continue;
        const left = `${t.task_count - t.completed_count} of ${t.task_count} tasks still open, ${t.progress}% done`;
        if (stage === "d3") await notify([t.user_id], "Target deadline in 3 days", `"${t.title}" is due on ${t.deadline} — ${left}.`, t.id);
        else if (stage === "d0") await notify([t.user_id], "Target due today", `"${t.title}" is due today — ${left}.`, t.id);
        else {
          await notify([t.user_id], "Target overdue", `"${t.title}" was due on ${t.deadline} — ${left}.`, t.id);
          await notify(await supervisorsOf(t.user_id), "Team target overdue", `${t.owner_name}'s "${t.title}" was due on ${t.deadline} — ${left}.`, t.id, t.user_id);
        }
      }
      if (hhmm >= "18:00") await digest();
    } catch (err: any) {
      console.warn("⚠️ Target reminders: " + err.message);
    }
  }
  async function digest() {
    const ups = await rows(
      `SELECT u.id, u.user_id, k.target_id, t.user_id AS owner_id, t.title FROM target_task_updates u
         JOIN target_tasks k ON k.id = u.task_id JOIN targets t ON t.id = k.target_id
        WHERE u.digested = 0 AND u.user_id = t.user_id`
    ).catch(() => []);
    const byOwner = new Map<number, any[]>();
    for (const u of ups) {
      const o = Number(u.owner_id);
      if (!byOwner.has(o)) byOwner.set(o, []);
      byOwner.get(o)!.push(u);
    }
    for (const [owner, list] of byOwner) {
      const ids = list.map((u) => Number(u.id));
      const r: any = await queryDB(`UPDATE target_task_updates SET digested = 1 WHERE id IN (${placeholders(ids.length)}) AND digested = 0`, ids);
      if (r && r.affectedRows === 0) continue;
      const name = (await employeeOf(owner))?.name || (await rows("SELECT name FROM users WHERE id = ?", [owner]))[0]?.name || "Someone";
      const titles = Array.from(new Set(list.map((u) => `"${u.title}"`))).join(", ");
      await notify(await supervisorsOf(owner), "Target updates today", `${name} made ${list.length} update${list.length === 1 ? "" : "s"} on ${titles}.`, Number(list[list.length - 1].target_id), owner);
    }
    // Updates by a supervisor were told to the Employee at once.
    await queryDB("UPDATE target_task_updates u JOIN target_tasks k ON k.id = u.task_id JOIN targets t ON t.id = k.target_id SET u.digested = 1 WHERE u.digested = 0 AND u.user_id <> t.user_id").catch(() => undefined);
  }
  if (runsBackgroundJobs()) {
    setTimeout(remind, 100 * 1000);
    setInterval(remind, 30 * 60 * 1000);
  }
}
