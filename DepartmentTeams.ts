/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Departments: a Head of Department and teams, each team with its own
// Supervisor (Admin Panel -> Departments, module "departments").
//
//   departments.head_user_id   the Head of Department (a login, users.id).
//   department_teams           a team of a Department: name, its Supervisor,
//                              and everyone_else = 1 for the one team that also
//                              holds everyone in the Department who is in no
//                              other team (new hires land there by themselves).
//   department_team_members    who is in a team; one team per person.
//
// Approval (server.ts createTemplateApprovalRequest), in this order:
//   1. Supervisor — the person's own Direct Supervisor (Employees ->
//      Supervisor) if set; else THEIR OWN team's Supervisor
//      (resolveTeamSupervisor). Never another team's Supervisor. A person in
//      no team has no Supervisor step.
//   2. Head of Department — always, when the Department has a Head (not when
//      the Head is the requester or already the Supervisor step).
//   3. The Approval Template's layers, as before.
//
// Once (startup marker department_teams_from_supervisor): every Department
// that had a Supervisor (departments.supervisor_user_id, with "include in
// approval" on) gets one team "<Department> team" with that Supervisor and
// everyone_else = 1 — so every request goes exactly where it went before.
// They also become the Department's Head where none is set (Tasks, Targets
// and Module Access treat the Head as the department head, as they treated
// the Supervisor) — Head = Supervisor, so approvals don't gain a step.
// The old column stays for now (nothing reads it any more).
//
// Members can come from any Department (15 Nov): a team's Supervisor may lead
// people from several projects and departments. A member's own team (in any
// Department) wins; the "everyone else" team of their own Department catches
// people in no team. The Head step stays the member's OWN Department's Head.
//
//   department_team_auto       "new joiners at <Work station> (in <Department>
//                              or any) join this team": an employee created
//                              after the rule, in no team, is added once
//                              (department_team_auto_done) — removing them by
//                              hand keeps them out. applyAutoTeams() runs
//                              before a Supervisor is looked up, after a save
//                              and every 5 minutes.
//
// Access: setting the Head, teams and members needs Departments + its
// edit_add layer (UI and API). Being a Head or a team Supervisor opens no
// Admin module by itself.

import type { Express } from "express";
import { getStartupMarker, setStartupMarker } from "./startupOnce";
import { activeCompanyId } from "./companyContext";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export async function ensureDepartmentTeamsSchema(dbPool: any): Promise<void> {
  const run = async (label: string, sql: string, ignore: string[] = []) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (!ignore.includes(err.code)) console.warn(`⚠️ Department teams (${label}): ${err.message}`);
    }
  };
  const dup = ["ER_DUP_FIELDNAME"];
  await run("departments.head_user_id", "ALTER TABLE departments ADD COLUMN head_user_id INT NULL", dup);
  await run("approval_requests.head_step_user_id", "ALTER TABLE approval_requests ADD COLUMN head_step_user_id INT NULL", dup);
  await run(
    "department_teams",
    `CREATE TABLE IF NOT EXISTS department_teams (
      id INT AUTO_INCREMENT PRIMARY KEY,
      department_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      supervisor_user_id INT NULL,
      everyone_else TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_department_teams_dept (department_id),
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE
    )`
  );
  await run(
    "department_team_members",
    `CREATE TABLE IF NOT EXISTS department_team_members (
      id INT AUTO_INCREMENT PRIMARY KEY,
      team_id INT NOT NULL,
      employee_id INT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_team_member (employee_id),
      FOREIGN KEY (team_id) REFERENCES department_teams(id) ON DELETE CASCADE
    )`
  );
  await run(
    "department_team_auto",
    `CREATE TABLE IF NOT EXISTS department_team_auto (
      id INT AUTO_INCREMENT PRIMARY KEY,
      team_id INT NOT NULL,
      branch VARCHAR(150) NOT NULL,
      department_id INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX (team_id),
      FOREIGN KEY (team_id) REFERENCES department_teams(id) ON DELETE CASCADE
    )`
  );
  await run(
    "department_team_auto_done",
    `CREATE TABLE IF NOT EXISTS department_team_auto_done (
      rule_id INT NOT NULL,
      employee_id INT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (rule_id, employee_id)
    )`
  );
  try {
    if (!(await getStartupMarker(dbPool, "department_teams_from_supervisor"))) {
      const [depts]: any = await dbPool.query(
        "SELECT id, name, supervisor_user_id FROM departments WHERE supervisor_user_id IS NOT NULL AND COALESCE(include_supervisor_approval, 1) = 1"
      );
      let made = 0;
      for (const d of depts || []) {
        const [has]: any = await dbPool.query("SELECT id FROM department_teams WHERE department_id = ? LIMIT 1", [d.id]);
        if ((has || []).length) continue;
        await dbPool.query("INSERT INTO department_teams (department_id, name, supervisor_user_id, everyone_else) VALUES (?, ?, ?, 1)", [
          d.id,
          `${String(d.name).slice(0, 110)} team`,
          d.supervisor_user_id
        ]);
        // They were also the Department's head (Tasks, Targets, Module
        // Access): keep that. Head = the team's Supervisor, so the Head step
        // is skipped and approvals stay exactly as they were.
        await dbPool.query("UPDATE departments SET head_user_id = ? WHERE id = ? AND head_user_id IS NULL", [d.supervisor_user_id, d.id]);
        made++;
      }
      await setStartupMarker(dbPool, "department_teams_from_supervisor", String(made));
    }
  } catch (err: any) {
    console.warn("⚠️ Could not turn Department Supervisors into teams: " + err.message);
  }
}

// The Supervisor of the employee's own team in their own Department (their
// team, else the Department's "everyone else" team), or null — never the
// employee themselves.
export async function resolveTeamSupervisor(queryDB: QueryDB, employeeUserId: number): Promise<number | null> {
  await applyAutoTeams(queryDB);
  try {
    const e = ((await queryDB(
      "SELECT e.id, e.department_id FROM all_employees e JOIN departments d ON d.id = e.department_id WHERE e.user_id = ? AND d.is_active = 1 LIMIT 1",
      [employeeUserId]
    )) || [])[0];
    if (!e) return null;
    const own = ((await queryDB(
      `SELECT t.supervisor_user_id FROM department_team_members m JOIN department_teams t ON t.id = m.team_id
        WHERE m.employee_id = ? AND t.is_active = 1 LIMIT 1`,
      [e.id]
    )) || [])[0];
    const team =
      own ||
      ((await queryDB(
        `SELECT t.supervisor_user_id FROM department_teams t
          WHERE t.department_id = ? AND t.everyone_else = 1 AND t.is_active = 1
            AND NOT EXISTS (SELECT 1 FROM department_team_members m JOIN department_teams o ON o.id = m.team_id WHERE m.employee_id = ? AND o.is_active = 1)
          LIMIT 1`,
        [e.department_id, e.id]
      )) || [])[0];
    const id = Number(team?.supervisor_user_id);
    return id && id !== Number(employeeUserId) ? id : null;
  } catch (err: any) {
    console.warn("⚠️ Could not resolve the team supervisor: " + err.message);
    return null;
  }
}

// New joiners into the teams whose auto rule matches them: created after the
// rule, at its Work station (Employees -> Branch), in its Department (or any),
// active, in no team yet, and not added by this rule before.
let autoRunning: Promise<void> | null = null;
export async function applyAutoTeams(queryDB: QueryDB): Promise<number> {
  if (autoRunning) { await autoRunning; return 0; }
  let added = 0;
  autoRunning = (async () => {
    try {
      const rules: any[] =
        (await queryDB(
          "/*unscoped*/ SELECT r.id, r.team_id, r.branch, r.department_id, r.created_at FROM department_team_auto r JOIN department_teams t ON t.id = r.team_id WHERE t.is_active = 1"
        )) || [];
      for (const r of rules) {
        const hits: any[] =
          (await queryDB(
            `/*unscoped*/ SELECT e.id FROM all_employees e LEFT JOIN branches b ON b.id = e.branch_id
              WHERE COALESCE(e.is_active, 1) = 1 AND e.created_at >= ?
                AND LOWER(TRIM(COALESCE(b.branch_name, e.branch, ''))) = LOWER(TRIM(?))
                AND (? IS NULL OR e.department_id = ?)
                AND NOT EXISTS (SELECT 1 FROM department_team_members m WHERE m.employee_id = e.id)
                AND NOT EXISTS (SELECT 1 FROM department_team_auto_done x WHERE x.rule_id = ? AND x.employee_id = e.id)`,
            [r.created_at, r.branch, r.department_id, r.department_id, r.id]
          )) || [];
        for (const h of hits) {
          await queryDB("/*unscoped*/ INSERT IGNORE INTO department_team_members (team_id, employee_id) VALUES (?, ?)", [r.team_id, h.id]);
          await queryDB("/*unscoped*/ INSERT IGNORE INTO department_team_auto_done (rule_id, employee_id) VALUES (?, ?)", [r.id, h.id]);
          added++;
        }
      }
    } catch (err: any) {
      console.warn("⚠️ Could not add new joiners to their teams: " + err.message);
    }
  })();
  try { await autoRunning; } finally { autoRunning = null; }
  return added;
}

// The Head of the employee's Department, or null (none, or the employee).
export async function resolveDepartmentHead(queryDB: QueryDB, employeeUserId: number): Promise<number | null> {
  try {
    const r = ((await queryDB(
      "SELECT d.head_user_id FROM all_employees e JOIN departments d ON d.id = e.department_id WHERE e.user_id = ? AND d.is_active = 1 LIMIT 1",
      [employeeUserId]
    )) || [])[0];
    const id = Number(r?.head_user_id);
    return id && id !== Number(employeeUserId) ? id : null;
  } catch (err: any) {
    console.warn("⚠️ Could not resolve the Head of Department: " + err.message);
    return null;
  }
}

// Every employee (all_employees.id) -> the login of their team's Supervisor,
// for screens that list "my team" (OT Approval). Employees in no team are
// left out.
export async function teamSupervisorByEmployee(queryDB: QueryDB): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    const [emps, teams, members]: any[] = await Promise.all([
      queryDB("SELECT id, department_id, user_id FROM all_employees WHERE department_id IS NOT NULL"),
      queryDB("SELECT id, department_id, supervisor_user_id, everyone_else FROM department_teams WHERE is_active = 1"),
      queryDB("SELECT team_id, employee_id FROM department_team_members")
    ]);
    const teamById = new Map<number, any>((teams || []).map((t: any) => [Number(t.id), t]));
    const catchAll = new Map<number, any>();
    for (const t of teams || []) if (Number(t.everyone_else) === 1) catchAll.set(Number(t.department_id), t);
    const memberOf = new Map<number, any>();
    for (const m of members || []) {
      const t = teamById.get(Number(m.team_id));
      if (t) memberOf.set(Number(m.employee_id), t);
    }
    for (const e of emps || []) {
      const own = memberOf.get(Number(e.id));
      const t = own || catchAll.get(Number(e.department_id));
      const sup = Number(t?.supervisor_user_id);
      if (sup && sup !== Number(e.user_id)) out.set(Number(e.id), sup);
    }
  } catch {
    // no teams yet
  }
  return out;
}

export interface RegisterDepartmentTeamsDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: any;
  requireModuleLayer: any;
  queryDB: QueryDB;
  onChange: () => void; // approvals move to the new Supervisor / Head
}

export function registerDepartmentTeamsRoutes(app: Express, deps: RegisterDepartmentTeamsDeps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB, onChange } = deps;
  const canRead = [authenticateToken, requireAdmin, requireModule("departments")];
  const canEdit = [authenticateToken, requireAdmin, requireModule("departments"), requireModuleLayer("departments", "edit_add")];
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
  const fail = (res: any, err: any) => res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });

  const department = async (id: number) => {
    const d = ((await queryDB("SELECT * FROM departments WHERE id = ?", [id])) || [])[0];
    if (!d) throw bad("Department not found.", 404);
    return d;
  };
  const people = async (deptId: number) =>
    (((await queryDB("SELECT id, name, employee_id, designation, user_id, is_active, company_id FROM all_employees WHERE department_id = ?", [deptId])) || []) as any[]).filter(
      (e) => Number(e.is_active ?? 1) === 1
    );
  // Everyone a team may hold (any Department), with their Work station and
  // Department — the "Add people" picker filters by both.
  const pool = async () =>
    (((await queryDB(
      `SELECT e.id, e.name, e.employee_id, e.designation, e.user_id, e.is_active, e.department_id, d.name AS department_name,
              COALESCE(b.branch_name, e.branch) AS branch_name
         FROM all_employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN branches b ON b.id = e.branch_id`
    )) || []) as any[]).filter((e) => Number(e.is_active ?? 1) === 1);

  // Keep a new joiner's team up to date even when nobody asks for a Supervisor.
  const timer = setInterval(() => { applyAutoTeams(queryDB).catch(() => {}); }, 5 * 60 * 1000);
  (timer as any).unref?.();

  // One Department's teams, members, and who is in no team.
  app.get("/api/departments/:id/teams", ...canRead, async (req: any, res) => {
    try {
      const d = await department(Number(req.params.id));
      await applyAutoTeams(queryDB);
      const [teams, members, staff, everyone, users, allTeams, rules] = await Promise.all([
        queryDB("SELECT * FROM department_teams WHERE department_id = ? ORDER BY everyone_else DESC, name", [d.id]),
        queryDB("SELECT m.team_id, m.employee_id FROM department_team_members m JOIN department_teams t ON t.id = m.team_id WHERE t.is_active = 1"),
        people(Number(d.id)),
        pool(),
        queryDB("SELECT id, name FROM users"),
        queryDB("SELECT t.id, t.name, t.department_id, dd.name AS department_name FROM department_teams t LEFT JOIN departments dd ON dd.id = t.department_id WHERE t.is_active = 1"),
        queryDB("SELECT r.id, r.team_id, r.branch, r.department_id, r.created_at FROM department_team_auto r JOIN department_teams t ON t.id = r.team_id WHERE t.department_id = ?", [d.id]).catch(() => [])
      ]);
      const userName = new Map<number, string>((users || []).map((u: any) => [Number(u.id), u.name]));
      const poolIds = new Set(everyone.map((e) => Number(e.id)));
      const teamInfo = new Map<number, any>((allTeams || []).map((t: any) => [Number(t.id), t]));
      // Every employee's team, in any Department ("now in … team").
      const teamOfEmp = new Map<number, number>();
      for (const m of members || []) if (teamInfo.has(Number(m.team_id))) teamOfEmp.set(Number(m.employee_id), Number(m.team_id));
      const out = (teams || [])
        .filter((t: any) => Number(t.is_active ?? 1) === 1)
        .map((t: any) => ({
          id: Number(t.id),
          name: t.name,
          supervisor_user_id: t.supervisor_user_id == null ? null : Number(t.supervisor_user_id),
          supervisor_name: t.supervisor_user_id ? userName.get(Number(t.supervisor_user_id)) || null : null,
          everyone_else: Number(t.everyone_else) === 1,
          member_ids: (members || []).filter((m: any) => Number(m.team_id) === Number(t.id) && poolIds.has(Number(m.employee_id))).map((m: any) => Number(m.employee_id)),
          auto: (rules || []).filter((r: any) => Number(r.team_id) === Number(t.id)).map((r: any) => ({ branch: r.branch, department_id: r.department_id == null ? null : Number(r.department_id) }))
        }));
      const catchAll = out.find((t: any) => t.everyone_else);
      const person = (e: any) => {
        const tid = teamOfEmp.get(Number(e.id));
        const ti = tid ? teamInfo.get(tid) : null;
        return {
          id: Number(e.id), name: e.name, employee_code: e.employee_id || null, designation: e.designation || null, user_id: e.user_id == null ? null : Number(e.user_id),
          department_id: e.department_id == null ? null : Number(e.department_id), department: e.department_name || null, branch: e.branch_name || null,
          team_id: tid || null, team_name: ti ? ti.name : null, team_department: ti ? ti.department_name : null
        };
      };
      res.json({
        department: { id: Number(d.id), name: d.name, head_user_id: d.head_user_id == null ? null : Number(d.head_user_id), head_name: d.head_user_id ? userName.get(Number(d.head_user_id)) || null : null },
        teams: out,
        people: staff.map((e) => person(everyone.find((x) => Number(x.id) === Number(e.id)) || e)).sort((a, b) => String(a.name).localeCompare(String(b.name))),
        // Anyone a team may hold, from every Department (the "Add people" picker).
        pool: everyone.map(person).sort((a, b) => String(a.name).localeCompare(String(b.name))),
        // In no team anywhere (and no "everyone else" team to catch them):
        // their requests go to the Head of Department, then the workflow.
        no_team: catchAll ? [] : staff.filter((e) => !teamOfEmp.has(Number(e.id))).map((e) => ({ id: Number(e.id), name: e.name }))
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Save the Head and the whole set of teams. Body: { head_user_id,
  // teams: [{ id?, name, supervisor_user_id, everyone_else, member_ids,
  // auto: [{ branch, department_id | null }] }] }.
  app.put("/api/departments/:id/teams", ...canEdit, async (req: any, res) => {
    try {
      const d = await department(Number(req.params.id));
      const b = req.body || {};
      const userIds = new Set<number>((((await queryDB("SELECT id FROM users")) || []) as any[]).map((u) => Number(u.id)));
      const headId = b.head_user_id ? Number(b.head_user_id) : null;
      if (headId && !userIds.has(headId)) throw bad("The Head of Department's account was not found.");
      const teams: any[] = Array.isArray(b.teams) ? b.teams : [];
      if (teams.length > 50) throw bad("At most 50 teams in a Department.");
      // Any active employee of this company, from any Department.
      const everyone = new Set((await pool()).map((e) => Number(e.id)));
      const deptIds = new Set((((await queryDB("SELECT id FROM departments")) || []) as any[]).map((x) => Number(x.id)));
      const seen = new Set<number>();
      const names = new Set<string>();
      let catchAll = 0;
      const clean = teams.map((t) => {
        const name = String(t?.name || "").trim().slice(0, 120);
        if (!name) throw bad("Give every team a name.");
        if (names.has(name.toLowerCase())) throw bad(`Two teams are called "${name}".`);
        names.add(name.toLowerCase());
        const sup = t?.supervisor_user_id ? Number(t.supervisor_user_id) : null;
        if (!sup) throw bad(`Pick the Supervisor of "${name}".`);
        if (!userIds.has(sup)) throw bad(`The Supervisor of "${name}" was not found.`);
        const everyoneElse = !!t?.everyone_else;
        if (everyoneElse) catchAll++;
        const ids: number[] = (Array.isArray(t?.member_ids) ? t.member_ids : []).map(Number);
        if (ids.length > 2000) throw bad(`Too many people in "${name}".`);
        for (const id of ids) {
          if (!everyone.has(id)) throw bad(`Someone in "${name}" is not an active employee.`);
          if (seen.has(id)) throw bad("A person can be in only one team.");
          seen.add(id);
        }
        const auto: { branch: string; department_id: number | null }[] = [];
        for (const r of Array.isArray(t?.auto) ? t.auto.slice(0, 50) : []) {
          const branch = String(r?.branch || "").trim().slice(0, 150);
          const dep = r?.department_id ? Number(r.department_id) : null;
          if (!branch) continue;
          if (dep && !deptIds.has(dep)) throw bad(`A new-joiner rule of "${name}" names a Department that was not found.`);
          if (!auto.some((x) => x.branch.toLowerCase() === branch.toLowerCase() && x.department_id === dep)) auto.push({ branch, department_id: dep });
        }
        return { id: t?.id ? Number(t.id) : null, name, sup, everyoneElse, ids, auto };
      });
      if (catchAll > 1) throw bad('Only one team can hold "everyone else in the Department".');
      const existing: any[] = (await queryDB("SELECT id FROM department_teams WHERE department_id = ?", [d.id])) || [];
      const keep = new Set(clean.filter((t) => t.id).map((t) => t.id as number));
      for (const t of clean) if (t.id && !existing.some((x) => Number(x.id) === t.id)) throw bad("One of the teams belongs to another Department.");

      await queryDB("UPDATE departments SET head_user_id = ? WHERE id = ?", [headId, d.id]);
      for (const x of existing) if (!keep.has(Number(x.id))) await queryDB("DELETE FROM department_teams WHERE id = ?", [x.id]);
      for (const t of clean) {
        let id = t.id;
        if (id) await queryDB("UPDATE department_teams SET name = ?, supervisor_user_id = ?, everyone_else = ?, is_active = 1 WHERE id = ?", [t.name, t.sup, t.everyoneElse ? 1 : 0, id]);
        else id = Number(((await queryDB("INSERT INTO department_teams (department_id, name, supervisor_user_id, everyone_else) VALUES (?, ?, ?, ?)", [d.id, t.name, t.sup, t.everyoneElse ? 1 : 0])) as any).insertId);
        await queryDB("DELETE FROM department_team_members WHERE team_id = ?", [id]);
        if (t.ids.length) {
          // A person moved here from a team of another Department leaves it.
          await queryDB(`DELETE FROM department_team_members WHERE employee_id IN (${t.ids.map(() => "?").join(",")})`, t.ids);
          await queryDB(`INSERT INTO department_team_members (team_id, employee_id) VALUES ${t.ids.map(() => "(?, ?)").join(", ")}`, t.ids.flatMap((e) => [id, e]));
        }
        // New-joiner rules: an unchanged rule keeps its date (only people who join after it count).
        const had: any[] = (await queryDB("SELECT id, branch, department_id FROM department_team_auto WHERE team_id = ?", [id]).catch(() => [])) || [];
        const same = (r: any, x: any) => String(r.branch).toLowerCase() === x.branch.toLowerCase() && (r.department_id == null ? null : Number(r.department_id)) === x.department_id;
        for (const r of had) if (!t.auto.some((x) => same(r, x))) await queryDB("DELETE FROM department_team_auto WHERE id = ?", [r.id]);
        for (const x of t.auto) if (!had.some((r) => same(r, x))) await queryDB("INSERT INTO department_team_auto (team_id, branch, department_id) VALUES (?, ?, ?)", [id, x.branch, x.department_id]);
      }
      onChange();
      res.json({ success: true, company: activeCompanyId() });
    } catch (err) {
      fail(res, err);
    }
  });
}
