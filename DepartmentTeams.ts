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
  try {
    const e = ((await queryDB(
      "SELECT e.id, e.department_id FROM all_employees e JOIN departments d ON d.id = e.department_id WHERE e.user_id = ? AND d.is_active = 1 LIMIT 1",
      [employeeUserId]
    )) || [])[0];
    if (!e) return null;
    const own = ((await queryDB(
      `SELECT t.supervisor_user_id FROM department_team_members m JOIN department_teams t ON t.id = m.team_id
        WHERE m.employee_id = ? AND t.department_id = ? AND t.is_active = 1 LIMIT 1`,
      [e.id, e.department_id]
    )) || [])[0];
    const team =
      own ||
      ((await queryDB(
        `SELECT t.supervisor_user_id FROM department_teams t
          WHERE t.department_id = ? AND t.everyone_else = 1 AND t.is_active = 1
            AND NOT EXISTS (SELECT 1 FROM department_team_members m JOIN department_teams o ON o.id = m.team_id WHERE m.employee_id = ? AND o.department_id = t.department_id AND o.is_active = 1)
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
      const t = own && Number(own.department_id) === Number(e.department_id) ? own : catchAll.get(Number(e.department_id));
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

  // One Department's teams, members, and who is in no team.
  app.get("/api/departments/:id/teams", ...canRead, async (req: any, res) => {
    try {
      const d = await department(Number(req.params.id));
      const [teams, members, staff, users] = await Promise.all([
        queryDB("SELECT * FROM department_teams WHERE department_id = ? ORDER BY everyone_else DESC, name", [d.id]),
        queryDB("SELECT m.team_id, m.employee_id FROM department_team_members m JOIN department_teams t ON t.id = m.team_id WHERE t.department_id = ?", [d.id]),
        people(Number(d.id)),
        queryDB("SELECT id, name FROM users")
      ]);
      const userName = new Map<number, string>((users || []).map((u: any) => [Number(u.id), u.name]));
      const staffIds = new Set(staff.map((e) => Number(e.id)));
      const inTeam = new Set<number>();
      const out = (teams || [])
        .filter((t: any) => Number(t.is_active ?? 1) === 1)
        .map((t: any) => {
          const ids = (members || []).filter((m: any) => Number(m.team_id) === Number(t.id) && staffIds.has(Number(m.employee_id))).map((m: any) => Number(m.employee_id));
          ids.forEach((x: number) => inTeam.add(x));
          return {
            id: Number(t.id),
            name: t.name,
            supervisor_user_id: t.supervisor_user_id == null ? null : Number(t.supervisor_user_id),
            supervisor_name: t.supervisor_user_id ? userName.get(Number(t.supervisor_user_id)) || null : null,
            everyone_else: Number(t.everyone_else) === 1,
            member_ids: ids
          };
        });
      const catchAll = out.find((t: any) => t.everyone_else);
      res.json({
        department: { id: Number(d.id), name: d.name, head_user_id: d.head_user_id == null ? null : Number(d.head_user_id), head_name: d.head_user_id ? userName.get(Number(d.head_user_id)) || null : null },
        teams: out,
        people: staff
          .map((e) => ({ id: Number(e.id), name: e.name, employee_code: e.employee_id || null, designation: e.designation || null, user_id: e.user_id == null ? null : Number(e.user_id) }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
        // In no team (and no "everyone else" team to catch them): their
        // requests go to the Head of Department, then the workflow.
        no_team: catchAll ? [] : staff.filter((e) => !inTeam.has(Number(e.id))).map((e) => ({ id: Number(e.id), name: e.name }))
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Save the Head and the whole set of teams. Body: { head_user_id,
  // teams: [{ id?, name, supervisor_user_id, everyone_else, member_ids }] }.
  app.put("/api/departments/:id/teams", ...canEdit, async (req: any, res) => {
    try {
      const d = await department(Number(req.params.id));
      const b = req.body || {};
      const userIds = new Set<number>((((await queryDB("SELECT id FROM users")) || []) as any[]).map((u) => Number(u.id)));
      const headId = b.head_user_id ? Number(b.head_user_id) : null;
      if (headId && !userIds.has(headId)) throw bad("The Head of Department's account was not found.");
      const teams: any[] = Array.isArray(b.teams) ? b.teams : [];
      if (teams.length > 50) throw bad("At most 50 teams in a Department.");
      const staff = new Set((await people(Number(d.id))).map((e) => Number(e.id)));
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
        for (const id of ids) {
          if (!staff.has(id)) throw bad(`Someone in "${name}" is not in ${d.name}.`);
          if (seen.has(id)) throw bad("A person can be in only one team.");
          seen.add(id);
        }
        return { id: t?.id ? Number(t.id) : null, name, sup, everyoneElse, ids };
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
      }
      onChange();
      res.json({ success: true, company: activeCompanyId() });
    } catch (err) {
      fail(res, err);
    }
  });
}
