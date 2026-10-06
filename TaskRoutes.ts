/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Tasks — giving work to people and tracking it to done.
//
//   HR (Admin Panel -> Task Management, module "task_management") gives a
//   task to anyone, sees every task, handles the employees' requests, sets up
//   recurring tasks and runs the monthly report.
//   A department head (departments.supervisor_user_id, Admin Panel ->
//   Departments) gives tasks to the people of that department from Self
//   Service -> My Tasks -> My Team.
//   An employee asks HR for something (employment certificate, ID card…) from Self Service -> My Tasks -> Request to HR; it lands in HR's
//   Requests list, where someone takes it or HR assigns it.
//
//   open -> in_progress -> done (the assignee submits it, with a note: that
//   finishes it) — or cancelled by whoever gave it / HR.
//
//   Self Service -> My Tasks is an off-by-default per-account switch
//   (users.can_view_tasks, Module Access); a "task_management" holder has it
//   too. Superadmin always.
//
//   Recurring tasks (task_recurrences) create a new task every day / week /
//   month; reminders go out on the due day and every day a task is overdue.
//
// tasks / task_recurrences carry company_id (companyScope.ts OWN_TABLES);
// task_assignees / task_comments hang off a task (LINKED_TABLES).

import type { Express } from "express";
import type { AlertType } from "./Alerts";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface TaskRouteDeps {
  authenticateToken: any;
  queryDB: QueryDB;
  getAdminModules: (userId: number) => Promise<string[]>;
  createAlert: (
    queryDB: QueryDB,
    params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }
  ) => Promise<void>;
}

export const TASK_CATEGORIES = ["general", "recruitment", "payroll", "letter", "document", "leave", "attendance", "training", "other"] as const;
// What an employee can ask HR for here. Salary Certificate, Experience
// Certificate, NOC and the Bank Account Opening Letter are NOT in this list:
// they are asked for from Self Service -> My Letters (HR Operations), which
// approves, numbers and files the letter — asking in both places would send HR
// two requests for the same thing.
export const TASK_REQUEST_TYPES: { key: string; label: string }[] = [
  { key: "employment_certificate", label: "Employment Certificate" },
  { key: "id_card", label: "ID Card" },
  { key: "visiting_card", label: "Visiting Card" },
  { key: "other", label: "Other" }
];
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const FREQUENCIES = ["daily", "weekly", "monthly"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function ensureTaskSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  const run = async (label: string, sql: string) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      console.warn(`⚠️ Could not ensure ${label}: ` + err.message);
    }
  };
  await run(
    "task_recurrences table",
    `CREATE TABLE IF NOT EXISTS task_recurrences (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      description TEXT NULL,
      category VARCHAR(40) NOT NULL DEFAULT 'general',
      priority VARCHAR(10) NOT NULL DEFAULT 'normal',
      assignee_ids VARCHAR(1000) NOT NULL,
      source VARCHAR(10) NOT NULL DEFAULT 'hr',
      department VARCHAR(150) NULL,
      frequency VARCHAR(10) NOT NULL,
      weekday TINYINT NULL,
      month_day TINYINT NULL,
      due_in_days INT NOT NULL DEFAULT 0,
      next_run DATE NOT NULL,
      last_run DATE NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
  await run(
    "tasks table",
    `CREATE TABLE IF NOT EXISTS tasks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      description TEXT NULL,
      source VARCHAR(10) NOT NULL DEFAULT 'hr',
      category VARCHAR(40) NOT NULL DEFAULT 'general',
      request_type VARCHAR(40) NULL,
      priority VARCHAR(10) NOT NULL DEFAULT 'normal',
      due_date DATE NULL,
      department VARCHAR(150) NULL,
      status VARCHAR(15) NOT NULL DEFAULT 'open',
      created_by INT NOT NULL,
      started_at DATETIME NULL,
      completed_by INT NULL,
      completed_at DATETIME NULL,
      completion_note TEXT NULL,
      cancelled_by INT NULL,
      cancelled_at DATETIME NULL,
      recurrence_id INT NULL,
      reminded_on DATE NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (recurrence_id) REFERENCES task_recurrences(id) ON DELETE SET NULL,
      INDEX idx_tasks_status (status)
    )`
  );
  await run(
    "task_assignees table",
    `CREATE TABLE IF NOT EXISTS task_assignees (
      id INT AUTO_INCREMENT PRIMARY KEY,
      task_id INT NOT NULL,
      user_id INT NOT NULL,
      assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_task_assignee (task_id, user_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
  await run(
    "task_comments table",
    `CREATE TABLE IF NOT EXISTS task_comments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      task_id INT NOT NULL,
      user_id INT NOT NULL,
      message TEXT NOT NULL,
      kind VARCHAR(15) NOT NULL DEFAULT 'comment',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_task_comments_task (task_id)
    )`
  );
}

// Today in Asia/Dhaka, YYYY-MM-DD.
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const ymd = (v: any): string | null => {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  const s = String(v).slice(0, 10);
  return DATE_RE.test(s) ? s : null;
};
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
// The next day on/after `from` that a recurrence runs.
function firstRun(from: string, frequency: string, weekday: number | null, monthDay: number | null): string {
  if (frequency === "weekly" && weekday !== null) {
    const t = new Date(`${from}T00:00:00Z`);
    const diff = (weekday - t.getUTCDay() + 7) % 7;
    return addDays(from, diff);
  }
  if (frequency === "monthly" && monthDay) {
    const [y, m, d] = from.split("-").map(Number);
    const dayIn = (yy: number, mm: number) => Math.min(monthDay, new Date(Date.UTC(yy, mm, 0)).getUTCDate());
    if (d <= dayIn(y, m)) return `${y}-${String(m).padStart(2, "0")}-${String(dayIn(y, m)).padStart(2, "0")}`;
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return `${ny}-${String(nm).padStart(2, "0")}-${String(dayIn(ny, nm)).padStart(2, "0")}`;
  }
  return from;
}
const nextRun = (after: string, frequency: string, weekday: number | null, monthDay: number | null) =>
  firstRun(addDays(after, 1), frequency, weekday, monthDay);

const str = (v: any, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const idList = (v: any): number[] =>
  Array.from(new Set<number>((Array.isArray(v) ? v : []).map(Number).filter((n: number) => Number.isFinite(n) && n > 0)));

export function registerTaskRoutes(app: Express, deps: TaskRouteDeps) {
  const { authenticateToken, queryDB, getAdminModules, createAlert } = deps;

  // ---- who may do what -------------------------------------------------
  async function isHr(user: any): Promise<boolean> {
    if (user.role === "superadmin") return true;
    return (await getAdminModules(Number(user.id))).includes("task_management");
  }
  async function hasMyTasks(user: any): Promise<boolean> {
    if (await isHr(user)) return true;
    const rows: any[] = (await queryDB("SELECT can_view_tasks FROM users WHERE id = ?", [user.id])) || [];
    return !!Number(rows[0]?.can_view_tasks || 0);
  }
  // Departments this account heads.
  async function headedDepartments(userId: number): Promise<{ id: number; name: string }[]> {
    const rows: any[] = (await queryDB("SELECT id, name FROM departments WHERE supervisor_user_id = ? AND is_active = 1", [userId])) || [];
    return rows.map((r) => ({ id: Number(r.id), name: String(r.name) }));
  }
  // Accounts of the people in those departments (not the head).
  async function teamMembers(userId: number, depts: { id: number; name: string }[]): Promise<any[]> {
    if (!depts.length) return [];
    const emps: any[] = (await queryDB("SELECT id, employee_id, name, designation, department, department_id, user_id FROM all_employees WHERE user_id IS NOT NULL")) || [];
    const ids = new Set(depts.map((d) => d.id));
    const names = new Set(depts.map((d) => d.name.toLowerCase()));
    return emps
      .filter((e) => (e.department_id && ids.has(Number(e.department_id))) || (e.department && names.has(String(e.department).toLowerCase())))
      .filter((e) => Number(e.user_id) !== Number(userId))
      .map((e) => ({ ...e, department: e.department || depts.find((d) => d.id === Number(e.department_id))?.name || null }));
  }
  async function access(user: any) {
    const hr = await isHr(user);
    const myTasks = hr || (await hasMyTasks(user));
    const deptRows = myTasks ? await headedDepartments(Number(user.id)) : [];
    return { hr, myTasks, deptRows, depts: deptRows.map((d) => d.name), hod: deptRows.length > 0 };
  }

  async function hrUserIds(): Promise<number[]> {
    const users: any[] = (await queryDB("SELECT id, role FROM users")) || [];
    const out: number[] = [];
    for (const u of users) {
      if (u.role === "superadmin") continue;
      if ((await getAdminModules(Number(u.id))).includes("task_management")) out.push(Number(u.id));
    }
    if (out.length) return out;
    return users.filter((u) => u.role === "superadmin").map((u) => Number(u.id));
  }

  async function notify(userIds: number[], title: string, message: string, taskId: number, exceptUserId?: number) {
    for (const uid of new Set(userIds.map(Number))) {
      if (!uid || uid === Number(exceptUserId)) continue;
      try {
        await createAlert(queryDB, { userId: uid, type: "task", title, message, relatedType: "task", relatedId: taskId });
      } catch (err: any) {
        console.warn("⚠️ Could not send task alert: " + err.message);
      }
    }
  }

  // ---- reading -----------------------------------------------------------
  async function loadTasks(where = "", params: any[] = []): Promise<any[]> {
    const [tasks, assignees, users, comments]: any[] = await Promise.all([
      queryDB(`SELECT * FROM tasks ${where}`, params),
      queryDB("SELECT * FROM task_assignees"),
      queryDB("SELECT id, name, email FROM users"),
      queryDB("SELECT task_id, COUNT(*) AS n FROM task_comments GROUP BY task_id")
    ]);
    const userById = new Map<number, any>((users || []).map((u: any) => [Number(u.id), u]));
    const byTask = new Map<number, number[]>();
    for (const a of assignees || []) {
      const t = Number(a.task_id);
      if (!byTask.has(t)) byTask.set(t, []);
      byTask.get(t)!.push(Number(a.user_id));
    }
    const commentCount = new Map<number, number>((comments || []).map((c: any) => [Number(c.task_id), Number(c.n)]));
    const now = today();
    return (tasks || []).map((t: any) => {
      const ids = byTask.get(Number(t.id)) || [];
      const due = ymd(t.due_date);
      const openish = t.status === "open" || t.status === "in_progress";
      const doneDay = ymd(t.completed_at);
      return {
        id: Number(t.id),
        title: t.title,
        description: t.description || "",
        source: t.source,
        category: t.category,
        request_type: t.request_type || null,
        priority: t.priority,
        due_date: due,
        department: t.department || null,
        status: t.status,
        overdue: openish && !!due && due < now,
        on_time: t.status === "done" ? !due || (!!doneDay && doneDay <= due) : null,
        created_by: Number(t.created_by),
        created_by_name: userById.get(Number(t.created_by))?.name || null,
        created_at: t.created_at,
        started_at: t.started_at || null,
        completed_by: t.completed_by ? Number(t.completed_by) : null,
        completed_by_name: t.completed_by ? userById.get(Number(t.completed_by))?.name || null : null,
        completed_at: t.completed_at || null,
        completion_note: t.completion_note || null,
        cancelled_at: t.cancelled_at || null,
        recurrence_id: t.recurrence_id ? Number(t.recurrence_id) : null,
        assignees: ids.map((id) => ({ id, name: userById.get(id)?.name || "Unknown" })),
        comment_count: commentCount.get(Number(t.id)) || 0
      };
    });
  }
  const byNewest = (a: any, b: any) => b.id - a.id;

  // What this account may do with one task.
  async function taskRights(task: any, user: any, acc?: Awaited<ReturnType<typeof access>>) {
    const a = acc || (await access(user));
    const uid = Number(user.id);
    const isAssignee = task.assignees.some((x: any) => x.id === uid);
    const isCreator = task.created_by === uid;
    const isHeadOf = a.hod && task.department && a.depts.some((d) => d.toLowerCase() === String(task.department).toLowerCase());
    const canSee = a.hr || isCreator || isAssignee || isHeadOf;
    const open = task.status === "open" || task.status === "in_progress";
    return {
      canSee,
      canWork: open && (isAssignee || (a.hr && task.source === "request")),
      canCancel: open && (isCreator || a.hr || (isHeadOf && task.source === "hod")),
      canAssign: open && a.hr,
      canComment: canSee
    };
  }

  async function oneTask(id: number) {
    return (await loadTasks("WHERE id = ?", [id]))[0] || null;
  }

  // ---- routes ------------------------------------------------------------
  app.get("/api/tasks/access", authenticateToken, async (req: any, res: any) => {
    try {
      const a = await access(req.user);
      res.json({ hr: a.hr, my_tasks: a.myTasks, hod: a.hod && a.myTasks, departments: a.depts, request_types: TASK_REQUEST_TYPES, categories: TASK_CATEGORIES });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Self Service lists: assigned to me / I asked HR for / I gave my team.
  app.get("/api/tasks/mine", authenticateToken, async (req: any, res: any) => {
    try {
      const a = await access(req.user);
      if (!a.myTasks) return res.status(403).json({ error: "My Tasks isn't turned on for your account." });
      const uid = Number(req.user.id);
      const all = await loadTasks();
      const assigned = all.filter((t) => t.assignees.some((x: any) => x.id === uid) && t.status !== "cancelled").sort(byNewest);
      const requested = all.filter((t) => t.source === "request" && t.created_by === uid).sort(byNewest);
      const team = a.hod ? all.filter((t) => t.source === "hod" && (t.created_by === uid || (t.department && a.depts.some((d) => d.toLowerCase() === String(t.department).toLowerCase())))).sort(byNewest) : [];
      res.json({ assigned, requested, team });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // HR: every task of the company.
  app.get("/api/tasks/all", authenticateToken, async (req: any, res: any) => {
    try {
      if (!(await isHr(req.user))) return res.status(403).json({ error: "Task Management access required." });
      res.json((await loadTasks()).sort(byNewest));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // People this account can give a task to.
  app.get("/api/tasks/assignable", authenticateToken, async (req: any, res: any) => {
    try {
      const a = await access(req.user);
      if (!a.hr && !(a.myTasks && a.hod)) return res.status(403).json({ error: "You can't assign tasks." });
      const users: any[] = (await queryDB("SELECT id, name, email, role, can_view_tasks FROM users")) || [];
      const emps: any[] = (await queryDB("SELECT employee_id, name, designation, department, user_id FROM all_employees WHERE user_id IS NOT NULL")) || [];
      const empByUser = new Map<number, any>(emps.map((e) => [Number(e.user_id), e]));
      const hrIds = new Set(await hrUserIds());
      let pool = users;
      if (!a.hr) {
        const team = new Set((await teamMembers(Number(req.user.id), a.deptRows)).map((e) => Number(e.user_id)));
        pool = users.filter((u) => team.has(Number(u.id)));
      }
      res.json(
        pool
          .map((u) => {
            const e = empByUser.get(Number(u.id));
            return {
              id: Number(u.id),
              name: e?.name || u.name,
              employee_id: e?.employee_id || null,
              designation: e?.designation || null,
              department: e?.department || null,
              // Can open My Tasks (or Task Management) to see it.
              can_see_tasks: u.role === "superadmin" || !!Number(u.can_view_tasks || 0) || hrIds.has(Number(u.id))
            };
          })
          .sort((x, y) => String(x.name).localeCompare(String(y.name)))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/tasks/:id(\\d+)", authenticateToken, async (req: any, res: any) => {
    try {
      const task = await oneTask(Number(req.params.id));
      if (!task) return res.status(404).json({ error: "Task not found." });
      const rights = await taskRights(task, req.user);
      if (!rights.canSee) return res.status(403).json({ error: "You can't see this task." });
      const comments: any[] = (await queryDB("SELECT * FROM task_comments WHERE task_id = ? ORDER BY id ASC", [task.id])) || [];
      const users: any[] = (await queryDB("SELECT id, name FROM users")) || [];
      const userName = new Map<number, string>(users.map((u) => [Number(u.id), u.name]));
      res.json({
        ...task,
        rights: { work: rights.canWork, cancel: rights.canCancel, assign: rights.canAssign, comment: rights.canComment },
        comments: comments.map((c) => ({ id: Number(c.id), user_id: Number(c.user_id), user_name: userName.get(Number(c.user_id)) || "Unknown", message: c.message, kind: c.kind, created_at: c.created_at }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Validates title/priority/category/due and who it goes to; returns the
  // cleaned fields or an error. HR: anyone; a department head: their team.
  async function cleanAssignment(body: any, user: any, a: Awaited<ReturnType<typeof access>>) {
    const title = str(body.title, 200);
    if (!title) return { error: "Title is required." };
    const priority = (PRIORITIES as readonly string[]).includes(body.priority) ? body.priority : "normal";
    const category = (TASK_CATEGORIES as readonly string[]).includes(body.category) ? body.category : "general";
    const due = body.due_date ? ymd(body.due_date) : null;
    if (body.due_date && !due) return { error: "Due date must be YYYY-MM-DD." };
    const assigneeIds = idList(body.assignee_ids);
    if (!assigneeIds.length) return { error: "Pick at least one person." };
    let source: "hr" | "hod" = "hr";
    let department: string | null = null;
    if (!a.hr || body.as_hod) {
      if (!a.myTasks || !a.hod) return { error: "You can't assign tasks." };
      const team = await teamMembers(Number(user.id), a.deptRows);
      const teamIds = new Set(team.map((e) => Number(e.user_id)));
      if (assigneeIds.some((id) => !teamIds.has(id))) return { error: "You can only give tasks to people in your department." };
      source = "hod";
      const depts = new Set(team.filter((e) => assigneeIds.includes(Number(e.user_id))).map((e) => String(e.department)));
      department = depts.size === 1 ? [...depts][0] : a.depts[0];
    } else {
      const users: any[] = (await queryDB("SELECT id FROM users")) || [];
      const known = new Set(users.map((u) => Number(u.id)));
      if (assigneeIds.some((id) => !known.has(id))) return { error: "Someone you picked isn't in this company." };
    }
    return { title, description: str(body.description, 5000) || null, priority, category, due, assigneeIds, source, department };
  }

  async function insertTask(f: any, createdBy: number, extra: { recurrenceId?: number | null; companyId?: number } = {}): Promise<number> {
    const cols = ["title", "description", "source", "category", "request_type", "priority", "due_date", "department", "status", "created_by", "recurrence_id"];
    const vals = [f.title, f.description, f.source, f.category, f.request_type || null, f.priority, f.due, f.department, "open", createdBy, extra.recurrenceId ?? null];
    if (extra.companyId) {
      cols.push("company_id");
      vals.push(extra.companyId);
    }
    const r: any = await queryDB(`INSERT INTO tasks (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, vals);
    const id = Number(r.insertId);
    for (const uid of f.assigneeIds || []) await queryDB("INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)", [id, uid]);
    return id;
  }

  const dueText = (due: string | null) => (due ? ` Due ${due}.` : "");

  // Give a task (HR, or a department head to their team).
  app.post("/api/tasks", authenticateToken, async (req: any, res: any) => {
    try {
      const a = await access(req.user);
      const f: any = await cleanAssignment(req.body || {}, req.user, a);
      if (f.error) return res.status(f.error === "You can't assign tasks." ? 403 : 400).json({ error: f.error });
      const id = await insertTask(f, Number(req.user.id));
      await notify(f.assigneeIds, "New task for you", `${req.user.name || "Someone"} gave you a task: "${f.title}".${dueText(f.due)}`, id, req.user.id);
      res.status(201).json(await oneTask(id));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // An employee asks HR for something.
  app.post("/api/tasks/request", authenticateToken, async (req: any, res: any) => {
    try {
      const a = await access(req.user);
      if (!a.myTasks) return res.status(403).json({ error: "My Tasks isn't turned on for your account." });
      const type = TASK_REQUEST_TYPES.find((t) => t.key === req.body?.request_type);
      if (!type) return res.status(400).json({ error: "Pick what you need." });
      const details = str(req.body?.description, 3000);
      const other = str(req.body?.title, 150);
      if (type.key === "other" && !other) return res.status(400).json({ error: "Say what you need." });
      const due = req.body?.due_date ? ymd(req.body.due_date) : null;
      if (req.body?.due_date && !due) return res.status(400).json({ error: "Needed-by date must be YYYY-MM-DD." });
      if (due && due < today()) return res.status(400).json({ error: "Needed-by date can't be in the past." });
      const emp: any[] = (await queryDB("SELECT department FROM all_employees WHERE user_id = ?", [req.user.id])) || [];
      const title = type.key === "other" ? other : type.label;
      const id = await insertTask(
        {
          title,
          description: details || null,
          source: "request",
          category: type.key === "employment_certificate" ? "letter" : "other",
          request_type: type.key,
          priority: "normal",
          due,
          department: emp[0]?.department || null,
          assigneeIds: []
        },
        Number(req.user.id)
      );
      await notify(await hrUserIds(), "New request to HR", `${req.user.name || "An employee"} asked for: ${title}.${due ? ` Needed by ${due}.` : ""}`, id, req.user.id);
      res.status(201).json(await oneTask(id));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  async function loadForAction(req: any, res: any) {
    const task = await oneTask(Number(req.params.id));
    if (!task) {
      res.status(404).json({ error: "Task not found." });
      return null;
    }
    const rights = await taskRights(task, req.user);
    if (!rights.canSee) {
      res.status(403).json({ error: "You can't see this task." });
      return null;
    }
    return { task, rights };
  }
  const addLog = (taskId: number, userId: number, message: string) =>
    queryDB("INSERT INTO task_comments (task_id, user_id, message, kind) VALUES (?, ?, ?, ?)", [taskId, userId, message, "event"]);
  const others = (task: any, uid: number) => [task.created_by, ...task.assignees.map((x: any) => x.id)].filter((id: number) => id !== uid);

  // HR: give a request (or any open task) to people / take it yourself.
  app.post("/api/tasks/:id(\\d+)/assign", authenticateToken, async (req: any, res: any) => {
    try {
      const ctx = await loadForAction(req, res);
      if (!ctx) return;
      if (!ctx.rights.canAssign) return res.status(403).json({ error: "Only HR can assign this task." });
      const ids = req.body?.take ? [Number(req.user.id)] : idList(req.body?.assignee_ids);
      if (!ids.length) return res.status(400).json({ error: "Pick at least one person." });
      const users: any[] = (await queryDB("SELECT id, name FROM users")) || [];
      const nameOf = new Map<number, string>(users.map((u) => [Number(u.id), u.name]));
      if (ids.some((id) => !nameOf.has(id))) return res.status(400).json({ error: "Someone you picked isn't in this company." });
      if (!req.body?.take) await queryDB("DELETE FROM task_assignees WHERE task_id = ?", [ctx.task.id]);
      for (const uid of ids) await queryDB("INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)", [ctx.task.id, uid]);
      await addLog(ctx.task.id, req.user.id, req.body?.take ? "Took this task" : `Assigned to ${ids.map((i) => nameOf.get(i)).join(", ")}`);
      await notify(ids, "Task assigned to you", `"${ctx.task.title}" is now yours.${dueText(ctx.task.due_date)}`, ctx.task.id, req.user.id);
      if (ctx.task.source === "request") {
        await notify([ctx.task.created_by], "HR is on your request", `${ids.map((i) => nameOf.get(i)).join(", ")} will handle "${ctx.task.title}".`, ctx.task.id, req.user.id);
      }
      res.json(await oneTask(ctx.task.id));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/tasks/:id(\\d+)/start", authenticateToken, async (req: any, res: any) => {
    try {
      const ctx = await loadForAction(req, res);
      if (!ctx) return;
      if (!ctx.rights.canWork) return res.status(403).json({ error: "This task isn't yours to work on." });
      if (ctx.task.status !== "open") return res.status(400).json({ error: "Already started." });
      if (ctx.task.source === "request" && !ctx.task.assignees.some((x: any) => x.id === Number(req.user.id))) {
        await queryDB("INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)", [ctx.task.id, req.user.id]);
      }
      await queryDB("UPDATE tasks SET status = ?, started_at = ? WHERE id = ?", ["in_progress", new Date(), ctx.task.id]);
      await addLog(ctx.task.id, req.user.id, "Started working on it");
      await notify([ctx.task.created_by], "Task started", `${req.user.name || "Someone"} started "${ctx.task.title}".`, ctx.task.id, req.user.id);
      res.json(await oneTask(ctx.task.id));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Submitting finishes the task.
  app.post("/api/tasks/:id(\\d+)/submit", authenticateToken, async (req: any, res: any) => {
    try {
      const ctx = await loadForAction(req, res);
      if (!ctx) return;
      if (!ctx.rights.canWork) return res.status(403).json({ error: "This task isn't yours to work on." });
      const note = str(req.body?.note, 3000);
      if (ctx.task.source === "request" && !ctx.task.assignees.some((x: any) => x.id === Number(req.user.id))) {
        await queryDB("INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)", [ctx.task.id, req.user.id]);
      }
      await queryDB("UPDATE tasks SET status = ?, completed_by = ?, completed_at = ?, completion_note = ?, started_at = COALESCE(started_at, ?) WHERE id = ?", [
        "done",
        req.user.id,
        new Date(),
        note || null,
        new Date(),
        ctx.task.id
      ]);
      await addLog(ctx.task.id, req.user.id, note ? `Submitted: ${note}` : "Submitted");
      const msg =
        ctx.task.source === "request"
          ? `Your request "${ctx.task.title}" is done.${note ? ` HR says: ${note}` : ""}`
          : `${req.user.name || "Someone"} finished "${ctx.task.title}".${note ? ` Note: ${note}` : ""}`;
      await notify(others(ctx.task, Number(req.user.id)), ctx.task.source === "request" ? "Your request is done" : "Task done", msg, ctx.task.id, req.user.id);
      res.json(await oneTask(ctx.task.id));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/tasks/:id(\\d+)/cancel", authenticateToken, async (req: any, res: any) => {
    try {
      const ctx = await loadForAction(req, res);
      if (!ctx) return;
      if (!ctx.rights.canCancel) return res.status(403).json({ error: "You can't cancel this task." });
      const reason = str(req.body?.reason, 1000);
      await queryDB("UPDATE tasks SET status = ?, cancelled_by = ?, cancelled_at = ? WHERE id = ?", ["cancelled", req.user.id, new Date(), ctx.task.id]);
      await addLog(ctx.task.id, req.user.id, reason ? `Cancelled: ${reason}` : "Cancelled");
      await notify(others(ctx.task, Number(req.user.id)), "Task cancelled", `"${ctx.task.title}" was cancelled.${reason ? ` ${reason}` : ""}`, ctx.task.id, req.user.id);
      res.json(await oneTask(ctx.task.id));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/tasks/:id(\\d+)/comments", authenticateToken, async (req: any, res: any) => {
    try {
      const ctx = await loadForAction(req, res);
      if (!ctx) return;
      const message = str(req.body?.message, 3000);
      if (!message) return res.status(400).json({ error: "Write something." });
      await queryDB("INSERT INTO task_comments (task_id, user_id, message, kind) VALUES (?, ?, ?, ?)", [ctx.task.id, req.user.id, message, "comment"]);
      // A request nobody has taken yet: HR hears about the employee's comment.
      const to = others(ctx.task, Number(req.user.id));
      if (ctx.task.source === "request" && !ctx.task.assignees.length && Number(req.user.id) === ctx.task.created_by) to.push(...(await hrUserIds()));
      await notify(to, `New comment: ${ctx.task.title}`.slice(0, 200), `${req.user.name || "Someone"}: ${message}`.slice(0, 500), ctx.task.id, req.user.id);
      res.status(201).json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- recurring ---------------------------------------------------------
  const serializeRecurrence = (r: any, userName: Map<number, string>) => {
    const ids = String(r.assignee_ids || "")
      .split(",")
      .map(Number)
      .filter((n) => n > 0);
    return {
      id: Number(r.id),
      title: r.title,
      description: r.description || "",
      category: r.category,
      priority: r.priority,
      source: r.source,
      department: r.department || null,
      frequency: r.frequency,
      weekday: r.weekday === null || r.weekday === undefined ? null : Number(r.weekday),
      month_day: r.month_day ? Number(r.month_day) : null,
      due_in_days: Number(r.due_in_days || 0),
      next_run: ymd(r.next_run),
      last_run: ymd(r.last_run),
      is_active: !!Number(r.is_active),
      created_by: Number(r.created_by),
      created_by_name: userName.get(Number(r.created_by)) || null,
      assignees: ids.map((id) => ({ id, name: userName.get(id) || "Unknown" }))
    };
  };

  app.get("/api/task-recurrences", authenticateToken, async (req: any, res: any) => {
    try {
      const a = await access(req.user);
      if (!a.hr && !(a.myTasks && a.hod)) return res.status(403).json({ error: "You can't set up recurring tasks." });
      const [rows, users]: any[] = await Promise.all([queryDB("SELECT * FROM task_recurrences"), queryDB("SELECT id, name FROM users")]);
      const userName = new Map<number, string>((users || []).map((u: any) => [Number(u.id), u.name]));
      const mine = req.query.scope === "team" || !a.hr ? (rows || []).filter((r: any) => r.source === "hod" && Number(r.created_by) === Number(req.user.id)) : rows || [];
      res.json(mine.map((r: any) => serializeRecurrence(r, userName)).sort((x: any, y: any) => y.id - x.id));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/task-recurrences", authenticateToken, async (req: any, res: any) => {
    try {
      const a = await access(req.user);
      const body = req.body || {};
      const f: any = await cleanAssignment({ ...body, due_date: null }, req.user, a);
      if (f.error) return res.status(f.error === "You can't assign tasks." ? 403 : 400).json({ error: f.error });
      const frequency = (FREQUENCIES as readonly string[]).includes(body.frequency) ? body.frequency : null;
      if (!frequency) return res.status(400).json({ error: "Pick daily, weekly or monthly." });
      const weekday = frequency === "weekly" ? Number(body.weekday) : null;
      if (frequency === "weekly" && !(weekday! >= 0 && weekday! <= 6)) return res.status(400).json({ error: "Pick the day of the week." });
      const monthDay = frequency === "monthly" ? Number(body.month_day) : null;
      if (frequency === "monthly" && !(monthDay! >= 1 && monthDay! <= 31)) return res.status(400).json({ error: "Pick the day of the month (1–31)." });
      const dueIn = Math.max(0, Math.min(60, Math.trunc(Number(body.due_in_days) || 0)));
      const start = body.start_date && ymd(body.start_date) ? (ymd(body.start_date) as string) : today();
      const first = firstRun(start < today() ? today() : start, frequency, weekday, monthDay);
      const r: any = await queryDB(
        "INSERT INTO task_recurrences (title, description, category, priority, assignee_ids, source, department, frequency, weekday, month_day, due_in_days, next_run, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [f.title, f.description, f.category, f.priority, f.assigneeIds.join(","), f.source, f.department, frequency, weekday, monthDay, dueIn, first, 1, req.user.id]
      );
      // Starts today: the first task right away.
      if (first === today()) await runRecurrences();
      const [rows, users]: any[] = await Promise.all([queryDB("SELECT * FROM task_recurrences WHERE id = ?", [Number(r.insertId)]), queryDB("SELECT id, name FROM users")]);
      res.status(201).json(serializeRecurrence(rows[0], new Map((users || []).map((u: any) => [Number(u.id), u.name]))));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  async function loadRecurrenceFor(req: any, res: any) {
    const a = await access(req.user);
    const rows: any[] = (await queryDB("SELECT * FROM task_recurrences WHERE id = ?", [Number(req.params.id)])) || [];
    const r = rows[0];
    if (!r) {
      res.status(404).json({ error: "Not found." });
      return null;
    }
    if (!a.hr && !(a.myTasks && a.hod && Number(r.created_by) === Number(req.user.id))) {
      res.status(403).json({ error: "You can't change this." });
      return null;
    }
    return r;
  }

  app.put("/api/task-recurrences/:id(\\d+)/active", authenticateToken, async (req: any, res: any) => {
    try {
      const r = await loadRecurrenceFor(req, res);
      if (!r) return;
      const on = !!req.body?.is_active;
      // Turned back on: carry on from today, not from the days it was off.
      const next = on && ymd(r.next_run)! < today() ? firstRun(today(), r.frequency, r.weekday === null ? null : Number(r.weekday), r.month_day ? Number(r.month_day) : null) : ymd(r.next_run);
      await queryDB("UPDATE task_recurrences SET is_active = ?, next_run = ? WHERE id = ?", [on ? 1 : 0, next, r.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/task-recurrences/:id(\\d+)", authenticateToken, async (req: any, res: any) => {
    try {
      const r = await loadRecurrenceFor(req, res);
      if (!r) return;
      await queryDB("DELETE FROM task_recurrences WHERE id = ?", [r.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- monthly report (HR) ----------------------------------------------
  app.get("/api/tasks/report", authenticateToken, async (req: any, res: any) => {
    try {
      if (!(await isHr(req.user))) return res.status(403).json({ error: "Task Management access required." });
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : today().slice(0, 7);
      const all = (await loadTasks()).filter((t) => t.status !== "cancelled");
      const inMonth = (t: any) => {
        const created = ymd(t.created_at) || "";
        const due = t.due_date || "";
        const done = ymd(t.completed_at) || "";
        return created.startsWith(month) || due.startsWith(month) || done.startsWith(month);
      };
      const rows = new Map<number, any>();
      for (const t of all.filter(inMonth)) {
        for (const a of t.assignees) {
          const r = rows.get(a.id) || { user_id: a.id, name: a.name, total: 0, done: 0, on_time: 0, late: 0, open: 0, overdue: 0, requests: 0 };
          r.total += 1;
          if (t.source === "request") r.requests += 1;
          if (t.status === "done") {
            r.done += 1;
            if (t.on_time) r.on_time += 1;
            else r.late += 1;
          } else {
            r.open += 1;
            if (t.overdue) r.overdue += 1;
          }
          rows.set(a.id, r);
        }
      }
      const waiting = all.filter((t) => t.source === "request" && !t.assignees.length && t.status === "open").length;
      res.json({ month, rows: [...rows.values()].sort((x, y) => y.total - x.total || x.name.localeCompare(y.name)), unassigned_requests: waiting });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- scheduler: recurring tasks and reminders --------------------------
  // Runs outside any request, so every company's rows are seen and new tasks
  // are written with the recurrence's own company_id.
  async function runRecurrences() {
    const now = today();
    const rows: any[] = (await queryDB("SELECT * FROM task_recurrences WHERE is_active = 1 AND next_run <= ?", [now]).catch(() => [])) || [];
    for (const r of rows) {
      try {
        const wd = r.weekday === null || r.weekday === undefined ? null : Number(r.weekday);
        const md = r.month_day ? Number(r.month_day) : null;
        const ids = String(r.assignee_ids || "")
          .split(",")
          .map(Number)
          .filter((n) => n > 0);
        // Claim this run first, so two ticks never create it twice.
        const claim: any = await queryDB("UPDATE task_recurrences SET next_run = ?, last_run = ? WHERE id = ? AND next_run = ?", [nextRun(now, r.frequency, wd, md), now, r.id, ymd(r.next_run)]);
        if (claim && claim.affectedRows === 0) continue;
        const due = addDays(now, Number(r.due_in_days || 0));
        const id = await insertTask(
          { title: r.title, description: r.description, source: r.source, category: r.category, priority: r.priority, due, department: r.department, assigneeIds: ids },
          Number(r.created_by),
          { recurrenceId: Number(r.id), companyId: Number(r.company_id || 1) }
        );
        await notify(ids, "New task for you", `"${r.title}" (repeats ${r.frequency}).${dueText(due)}`, id);
      } catch (err: any) {
        console.warn("⚠️ Recurring task: " + err.message);
      }
    }
  }

  async function remind() {
    try {
      await runRecurrences();
      const hhmm = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka", hour12: false }).slice(0, 5);
      if (hhmm < "09:00") return;
      const now = today();
      const open: any[] =
        (await queryDB("SELECT * FROM tasks WHERE status IN ('open', 'in_progress') AND due_date IS NOT NULL AND due_date <= ?", [now]).catch(() => [])) || [];
      if (!open.length) return;
      const assignees: any[] = (await queryDB("SELECT * FROM task_assignees").catch(() => [])) || [];
      for (const t of open) {
        if (ymd(t.reminded_on) === now) continue;
        const ids = assignees.filter((a) => Number(a.task_id) === Number(t.id)).map((a) => Number(a.user_id));
        const due = ymd(t.due_date)!;
        if (due === now) {
          await notify(ids, "Task due today", `"${t.title}" is due today.`, Number(t.id));
        } else {
          await notify(ids, "Task overdue", `"${t.title}" was due on ${due}. Please finish and submit it.`, Number(t.id));
          await notify([Number(t.created_by)], "Task overdue", `"${t.title}" (due ${due}) isn't done yet.`, Number(t.id), ids.length === 1 ? ids[0] : undefined);
        }
        await queryDB("UPDATE tasks SET reminded_on = ? WHERE id = ?", [now, Number(t.id)]);
      }
    } catch (err: any) {
      console.warn("⚠️ Task reminders: " + err.message);
    }
  }
  setTimeout(remind, 90 * 1000);
  setInterval(remind, 30 * 60 * 1000);
}
