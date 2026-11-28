/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> My Team (Dashboard card + its page): the people under this
// account and how each of them stands today, read-only.
//
// Under me (the same three ways approvals and Targets use, DepartmentTeams.ts):
//   head    — everyone in a Department I am Head of (departments.head_user_id);
//   team    — the members of a team I supervise (department_teams), and, for
//             an "everyone else" team, everyone of its Department in no team;
//   direct  — Employees whose Supervisor tab names me (employee_supervisors).
// One person can come in more than one way; they are listed once, with every
// way. Only active Employees who haven't left (AccountBlock.ts
// SEPARATED_JOB_STATUSES), never the viewer themself; Employees without a
// login are included (their office-machine punches still count).
//
// Access: NO module and no per-account switch — decided by the owner
// (23 Nov 2026): being a Head / Supervisor is the permission. Every request
// works out the team again from the database, so an account sees only the
// people under it right now (losing the Head / Supervisor role ends it at
// once) and nobody else's: GET /api/my-team/:employeeId refuses anyone not in
// the caller's team. Nothing here changes data.
//
// Today's status comes from Employee 360's day-by-day attendance
// (HrOps360Routes.ts computeAttendanceDays: office machine, Check In / Out,
// Site Attendance, approved Leave, holidays, Duty Roster, late policy), so it
// agrees with Employee 360, the Dashboard calendar and Payroll.

import type { Express } from "express";
import { SEPARATED_JOB_STATUSES } from "./AccountBlock";
import { computeAttendanceDays, leaveLabelFn, loadAttendanceData, summarizeDays, type AttendanceDay } from "./HrOps360Routes";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface Deps {
  authenticateToken: any;
  queryDB: QueryDB;
}

export type TeamVia = { kind: "head" | "team" | "direct"; label: string };
export type TodayStatus = "present" | "late" | "leave" | "off" | "not_in";

const dhakaToday = () => new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10);
const separated = new Set(SEPARATED_JOB_STATUSES);
const stillHere = (e: any) => Number(e.is_active ?? 1) === 1 && !separated.has(String(e.job_status || "").trim().toLowerCase());

/** The Employees under this account, each with the ways they are under it.
 *  Cheap when the account has no team (three small lookups, no Employee scan). */
export async function myTeamOf(queryDB: QueryDB, userId: number): Promise<Map<number, { emp: any; via: TeamVia[] }>> {
  const out = new Map<number, { emp: any; via: TeamVia[] }>();
  const uid = Number(userId);
  const [heads, teams, meRows]: any[] = await Promise.all([
    queryDB("SELECT id, name FROM departments WHERE head_user_id = ? AND is_active = 1", [uid]).catch(() => []),
    queryDB("SELECT id, name, department_id, everyone_else FROM department_teams WHERE supervisor_user_id = ? AND is_active = 1", [uid]).catch(() => []),
    queryDB("SELECT id FROM all_employees WHERE user_id = ?", [uid]).catch(() => [])
  ]);
  const myEmpIds = (meRows || []).map((r: any) => Number(r.id));
  const reports: any[] = myEmpIds.length
    ? (await queryDB(`SELECT employee_id, is_direct FROM employee_supervisors WHERE supervisor_id IN (${myEmpIds.map(() => "?").join(",")})`, myEmpIds).catch(() => [])) || []
    : [];
  if (!heads?.length && !teams?.length && !reports.length) return out;

  const emps: any[] = ((await queryDB("SELECT * FROM all_employees WHERE is_active = 1")) || []).filter(stillHere);
  const add = (e: any, via: TeamVia) => {
    if (Number(e.user_id) === uid || myEmpIds.includes(Number(e.id))) return;
    const cur = out.get(Number(e.id)) || { emp: e, via: [] };
    if (!cur.via.some((v) => v.kind === via.kind && v.label === via.label)) cur.via.push(via);
    out.set(Number(e.id), cur);
  };

  // Head of Department: the whole Department (by id, or by name for older rows).
  if (heads?.length) {
    const byId = new Map<number, string>(heads.map((d: any) => [Number(d.id), String(d.name)]));
    const byName = new Map<string, string>(heads.map((d: any) => [String(d.name).toLowerCase(), String(d.name)]));
    for (const e of emps) {
      const name = (e.department_id && byId.get(Number(e.department_id))) || (e.department && byName.get(String(e.department).toLowerCase()));
      if (name) add(e, { kind: "head", label: name });
    }
  }

  // Team Supervisor: own members (any Department); an "everyone else" team
  // also holds its Department's people who are in no team at all.
  if (teams?.length) {
    const members: any[] = (await queryDB("SELECT team_id, employee_id FROM department_team_members").catch(() => [])) || [];
    const inAnyTeam = new Set(members.map((m) => Number(m.employee_id)));
    const mine = new Map<number, any>(teams.map((t: any) => [Number(t.id), t]));
    const empById = new Map<number, any>(emps.map((e) => [Number(e.id), e]));
    for (const m of members) {
      const t = mine.get(Number(m.team_id));
      const e = t && empById.get(Number(m.employee_id));
      if (e) add(e, { kind: "team", label: String(t.name) });
    }
    for (const t of teams) {
      if (Number(t.everyone_else) !== 1) continue;
      for (const e of emps) if (Number(e.department_id) === Number(t.department_id) && !inAnyTeam.has(Number(e.id))) add(e, { kind: "team", label: String(t.name) });
    }
  }

  // Supervisor tab (Employees -> Supervisor).
  if (reports.length) {
    const direct = new Map<number, boolean>();
    for (const r of reports) direct.set(Number(r.employee_id), direct.get(Number(r.employee_id)) || Number(r.is_direct) === 1);
    for (const e of emps) if (direct.has(Number(e.id))) add(e, { kind: "direct", label: direct.get(Number(e.id)) ? "Direct report" : "Reports to you" });
  }
  return out;
}

const statusOf = (d: AttendanceDay | undefined): TodayStatus => {
  if (!d) return "not_in";
  if (d.status === "present") return d.late ? "late" : "present";
  if (d.status === "leave") return "leave";
  if (d.status === "holiday" || d.status === "weekend") return "off";
  return "not_in";
};

export function registerMyTeamRoutes(app: Express, deps: Deps) {
  const { authenticateToken, queryDB } = deps;

  const projectNames = async (): Promise<Map<number, string>> =>
    new Map(((await queryDB("SELECT id, project_name FROM projects").catch(() => [])) || []).map((p: any) => [Number(p.id), String(p.project_name)]));

  // Where today's In was given: the Project (or off-site place) of the
  // earliest Check In, else what the day's source says (office machine…).
  const placeOf = (day: AttendanceDay | undefined, remote: any[], projects: Map<number, string>): string | null => {
    if (!day?.in) return null;
    const first = remote
      .filter((r) => r.check_in_at && (r.attendance_date instanceof Date ? r.attendance_date.toLocaleDateString("en-CA") : String(r.attendance_date).slice(0, 10)) === day.date)
      .sort((a, b) => new Date(a.check_in_at).getTime() - new Date(b.check_in_at).getTime())[0];
    if (first && String(day.source || "").includes("Remote")) return first.check_in_place || projects.get(Number(first.project_id)) || "Check In";
    if (String(day.source || "").includes("Office")) return "Office machine";
    if (String(day.source || "").includes("Site")) return "Site attendance";
    return day.source || null;
  };

  const person = (emp: any, via: TeamVia[]) => ({
    id: Number(emp.id),
    user_id: emp.user_id != null ? Number(emp.user_id) : null,
    employee_id: emp.employee_id || null,
    name: emp.name,
    designation: emp.designation || null,
    department: emp.department || null,
    branch: emp.branch || null,
    via
  });

  // The team and today, for the Dashboard card and the My Team page.
  //   { has_team, date, summary: {total, present, late, leave, off, not_in},
  //     people: [{ id, user_id, employee_id, name, designation, department,
  //                branch, via, today: { status, in, out, place, late,
  //                leave_type, holiday } }] }
  app.get("/api/my-team", authenticateToken, async (req: any, res) => {
    try {
      const team = await myTeamOf(queryDB, Number(req.user.id));
      const date = dhakaToday();
      const summary = { total: team.size, present: 0, late: 0, leave: 0, off: 0, not_in: 0 };
      if (team.size === 0) return res.json({ has_team: false, date, summary, people: [] });
      const [data, label, projects] = await Promise.all([loadAttendanceData(queryDB, date, date), leaveLabelFn(queryDB), projectNames()]);
      const people = [...team.values()]
        .map(({ emp, via }) => {
          const day = computeAttendanceDays(data, emp, date, date, date, label)[0];
          const status = statusOf(day);
          summary[status]++;
          const remote = emp.user_id ? data.remoteByUser.get(Number(emp.user_id)) || [] : [];
          return {
            ...person(emp, via),
            today: {
              status,
              in: day?.in || null,
              out: day?.out || null,
              place: placeOf(day, remote, projects),
              late: day?.late || null,
              leave_type: day?.leave_type || null,
              holiday: day?.holiday || null
            }
          };
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      res.json({ has_team: true, date, summary, people });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Couldn't load your team." });
    }
  });

  // One person of the team: today, this month so far, contact. Refused for
  // anyone who isn't under the caller right now.
  app.get("/api/my-team/:employeeId(\\d+)", authenticateToken, async (req: any, res) => {
    try {
      const team = await myTeamOf(queryDB, Number(req.user.id));
      const hit = team.get(Number(req.params.employeeId));
      if (!hit) return res.status(403).json({ error: "This person isn't in your team." });
      const { emp, via } = hit;
      const today = dhakaToday();
      const from = `${today.slice(0, 7)}-01`;
      const [data, label, projects] = await Promise.all([loadAttendanceData(queryDB, from, today, emp), leaveLabelFn(queryDB), projectNames()]);
      const days = computeAttendanceDays(data, emp, from, today, today, label);
      const day = days[days.length - 1];
      const remote = emp.user_id ? data.remoteByUser.get(Number(emp.user_id)) || [] : [];
      const sum = summarizeDays(days.filter((d) => d.date < today || d.status !== "absent"));
      res.json({
        ...person(emp, via),
        email: emp.email || null,
        // Office Contact No. only — the personal mobile stays in Admin Panel -> Employees.
        phone: emp.phone || null,
        joining_date: emp.joining_date ? (emp.joining_date instanceof Date ? emp.joining_date.toLocaleDateString("en-CA") : String(emp.joining_date).slice(0, 10)) : null,
        today: {
          status: statusOf(day),
          in: day?.in || null,
          out: day?.out || null,
          place: placeOf(day, remote, projects),
          late: day?.late || null,
          leave_type: day?.leave_type || null,
          holiday: day?.holiday || null
        },
        // Absent only for someone with any attendance this month — a person
        // whose attendance isn't recorded at all isn't absent every day (the
        // Dashboard calendar and Payroll read it the same way): null then.
        month: { from, to: today, present: sum.present, late: sum.late + sum.extreme_late, leave: sum.leave, absent: sum.present > 0 ? sum.absent : null }
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Couldn't load this person." });
    }
  });
}
