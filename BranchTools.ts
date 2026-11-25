/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Branch / Project housekeeping (Admin Panel -> Branches and Projects):
//   - Link by name   : Branch + Project with exactly the same name, never linked, get linked.
//   - Archive        : hide a retired Branch / Project from lists and pickers; nothing is deleted.
//   - Merge Branch   : move a duplicate Branch's people (and the name copies) into the real one.
// The rules these must not break are written in docs/branch-project-rules.md.
// Everything is previewed first, checked again on the server, and never renames
// a Branch or a Project, never overwrites a map pin and never deletes a row.

import type { Express } from "express";
import { recordEmployeeEditHistory } from "./EmployeeTransferRoutes";
import { divisionOfBranchType, syncDivision } from "./BranchDivision";

interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: any) => any;
  requireModuleLayer: (moduleKey: any, layer: any) => any;
  hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  todayInDhaka: () => string;
}

const norm = (v: any) => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const hasPin = (o: any) => o.location_lat != null && o.location_lng != null;
const samePin = (a: any, b: any) =>
  Number(a.location_lat) === Number(b.location_lat) &&
  Number(a.location_lng) === Number(b.location_lng) &&
  (a.location_radius == null ? null : Number(a.location_radius)) === (b.location_radius == null ? null : Number(b.location_radius));

export function registerBranchToolsRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, hasModuleLayer, queryDB, todayInDhaka } = deps;

  // Active people per Branch, and how many of them are on "Their Branch" check-in.
  async function staffByBranch(): Promise<{ active: Map<number, number>; byBranchMode: Map<number, number> }> {
    const emps: any[] = (await queryDB("SELECT branch_id, user_id FROM all_employees WHERE is_active = 1 AND branch_id IS NOT NULL").catch(() => [])) || [];
    const flagged: any[] = (await queryDB("SELECT id FROM users WHERE attendance_projects_by_branch = 1").catch(() => [])) || [];
    const flaggedIds = new Set(flagged.map((u) => Number(u.id)));
    const active = new Map<number, number>();
    const byBranchMode = new Map<number, number>();
    for (const e of emps) {
      const b = Number(e.branch_id);
      active.set(b, (active.get(b) || 0) + 1);
      if (e.user_id != null && flaggedIds.has(Number(e.user_id))) byBranchMode.set(b, (byBranchMode.get(b) || 0) + 1);
    }
    return { active, byBranchMode };
  }

  // ---- Link by name ---------------------------------------------------
  type Pair = { branch: any; project: any };
  async function candidatePairs(): Promise<{ pairs: Pair[]; skipped: { branch_id: number; branch_name: string; project_name: string; reason: string }[] }> {
    const branches: any[] = await queryDB("SELECT * FROM branches");
    const projects: any[] = await queryDB("SELECT * FROM projects");
    const linkedProjects = new Set(branches.filter((b) => b.project_id).map((b) => Number(b.project_id)));
    const freeBranches = branches.filter((b) => !b.project_id);
    const freeProjects = projects.filter((p) => !linkedProjects.has(Number(p.id)));
    const branchesByName = new Map<string, any[]>();
    for (const b of freeBranches) branchesByName.set(norm(b.branch_name), [...(branchesByName.get(norm(b.branch_name)) || []), b]);
    const projectsByName = new Map<string, any[]>();
    for (const p of freeProjects) projectsByName.set(norm(p.project_name), [...(projectsByName.get(norm(p.project_name)) || []), p]);
    const pairs: Pair[] = [];
    const skipped: { branch_id: number; branch_name: string; project_name: string; reason: string }[] = [];
    for (const [name, bs] of branchesByName) {
      const ps = projectsByName.get(name);
      if (!ps) continue;
      if (bs.length > 1 || ps.length > 1) {
        for (const b of bs) skipped.push({ branch_id: Number(b.id), branch_name: b.branch_name, project_name: ps[0].project_name, reason: "More than one Branch or Project has this name — link it by hand." });
        continue;
      }
      const b = bs[0];
      const p = ps[0];
      if (hasPin(b) && hasPin(p) && !samePin(b, p)) {
        skipped.push({ branch_id: Number(b.id), branch_name: b.branch_name, project_name: p.project_name, reason: "The Branch and the Project have different map pins — check them first." });
        continue;
      }
      pairs.push({ branch: b, project: p });
    }
    return { pairs, skipped };
  }

  // Linking needs the same permission as linking from the Branch screen.
  const needProjectsEdit = async (req: any, res: any): Promise<boolean> => {
    if (!(await hasModuleLayer(req.user, "projects", "edit_add"))) {
      res.status(403).json({ error: "Linking a Branch to a Project needs Projects Edit/Add permission. Ask your Superadmin to grant it." });
      return false;
    }
    return true;
  };

  // ---- Link by choice ---------------------------------------------------
  // For Branches whose name differs from their Project's ("Kolatia Godown" /
  // "WIP-Kalatia (Godown)"): the Admin picks the Project for each Branch, with
  // the closest-named free Project already suggested. Same rules as Link by
  // name — a free Branch to a free Project, no name or pin is changed, and a
  // pin is shared only into the side that has none.
  const STOP = new Set(["wip", "plot", "p", "project", "ltd", "limited", "the", "of", "dhaka", "road", "r", "rd", "b", "block", "house", "no"]);
  const compact = (s: string) => norm(s).replace(/[^a-z0-9]+/g, "");
  const tokensOf = (s: string) =>
    norm(s).replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !STOP.has(w));
  const lev = (a: string, b: string) => {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  };
  const similar = (a: string, b: string) => {
    const ka = compact(a), kb = compact(b);
    if (!ka || !kb) return 0;
    if (ka === kb) return 1;
    let best = 1 - lev(ka, kb) / Math.max(ka.length, kb.length);
    if (Math.min(ka.length, kb.length) >= 5 && (ka.includes(kb) || kb.includes(ka))) best = Math.max(best, 0.85);
    // Word by word, allowing a spelling slip ("Kolatia" / "Kalatia", "Noor Park" / "Noorpark").
    const ta = tokensOf(a), tb = tokensOf(b);
    if (ta.length && tb.length) {
      const used = new Set<number>();
      let hit = 0;
      for (const x of ta) {
        const j = tb.findIndex((y, k) => !used.has(k) && (x === y || (Math.min(x.length, y.length) >= 4 && 1 - lev(x, y) / Math.max(x.length, y.length) >= 0.75)));
        if (j >= 0) { used.add(j); hit++; }
      }
      best = Math.max(best, hit / (ta.length + tb.length - hit));
    }
    return best;
  };
  // Marks a Branch + Project as linked (same steps Link by name takes).
  async function applyLink(branch: any, project: any) {
    await queryDB("UPDATE branches SET project_id = ? WHERE id = ? AND project_id IS NULL", [project.id, branch.id]);
    if (hasPin(branch) && !hasPin(project)) {
      await queryDB("UPDATE projects SET location_lat = ?, location_lng = ?, location_label = ?, location_radius = ? WHERE id = ?", [
        branch.location_lat, branch.location_lng, branch.location_label ?? null, branch.location_radius ?? null, project.id
      ]);
    } else if (hasPin(project) && !hasPin(branch)) {
      await queryDB("UPDATE branches SET location_lat = ?, location_lng = ?, location_label = ?, location_radius = ? WHERE id = ?", [
        project.location_lat, project.location_lng, project.location_label ?? null, project.location_radius ?? null, branch.id
      ]);
    }
  }

  app.get("/api/branches/link-suggestions", authenticateToken, requireAdmin, requireModule("branches"), async (req: any, res) => {
    try {
      if (!(await needProjectsEdit(req, res))) return;
      const branches: any[] = await queryDB("SELECT * FROM branches");
      const projects: any[] = await queryDB("SELECT * FROM projects");
      const linked = new Set(branches.filter((b) => b.project_id).map((b) => Number(b.project_id)));
      const freeProjects = projects.filter((p) => !linked.has(Number(p.id)) && !Number(p.is_archived));
      const staff = await staffByBranch();
      const rows = branches
        .filter((b) => !b.project_id && !Number(b.is_archived) && b.branch_type === "project_site" && (staff.active.get(Number(b.id)) || 0) > 0)
        .map((b) => {
          const ranked = freeProjects.map((p) => ({ p, s: similar(String(b.branch_name), String(p.project_name)) })).sort((x, y) => y.s - x.s);
          const top = ranked[0];
          const second = ranked[1];
          // Pre-selected only when clearly the best match; otherwise just offered.
          const sure = !!top && top.s >= 0.8 && (!second || top.s - second.s >= 0.15);
          return {
            branch_id: Number(b.id),
            branch_name: b.branch_name,
            branch_type: b.branch_type,
            staff: staff.active.get(Number(b.id)) || 0,
            their_branch_users: staff.byBranchMode.get(Number(b.id)) || 0,
            suggested_project_id: top && top.s >= 0.5 ? Number(top.p.id) : null,
            sure,
            score: top ? Math.round(top.s * 100) / 100 : 0
          };
        })
        .sort((a, b) => b.staff - a.staff || String(a.branch_name).localeCompare(String(b.branch_name)));
      res.json({
        branches: rows,
        projects: freeProjects.map((p) => ({ id: Number(p.id), name: p.project_name, has_pin: hasPin(p) })).sort((a, b) => String(a.name).localeCompare(String(b.name)))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/branches/link-pairs", authenticateToken, requireAdmin, requireModule("branches"), async (req: any, res) => {
    try {
      if (!(await needProjectsEdit(req, res))) return;
      const asked: any[] = Array.isArray(req.body?.pairs) ? req.body.pairs.slice(0, 500) : [];
      if (!asked.length) return res.status(400).json({ error: "Nothing to link." });
      const branches: any[] = await queryDB("SELECT * FROM branches");
      const projects: any[] = await queryDB("SELECT * FROM projects");
      const byBranch = new Map(branches.map((b) => [Number(b.id), b]));
      const byProject = new Map(projects.map((p) => [Number(p.id), p]));
      const usedProjects = new Set(branches.filter((b) => b.project_id).map((b) => Number(b.project_id)));
      let linked = 0;
      const skipped: string[] = [];
      for (const a of asked) {
        const b = byBranch.get(Number(a?.branch_id));
        const p = byProject.get(Number(a?.project_id));
        if (!b || !p) { skipped.push(`Branch ${Number(a?.branch_id)} / Project ${Number(a?.project_id)}: not found`); continue; }
        if (b.project_id) { skipped.push(`${b.branch_name}: already linked to a Project`); continue; }
        if (usedProjects.has(Number(p.id))) { skipped.push(`${b.branch_name}: "${p.project_name}" is already linked to another Branch`); continue; }
        if (Number(p.is_archived)) { skipped.push(`${b.branch_name}: "${p.project_name}" is archived`); continue; }
        if (hasPin(b) && hasPin(p) && !samePin(b, p)) { skipped.push(`${b.branch_name}: the Branch and "${p.project_name}" have different map pins — check them first`); continue; }
        try {
          await applyLink(b, p);
          usedProjects.add(Number(p.id));
          linked++;
        } catch (err: any) {
          skipped.push(`${b.branch_name}: ${err.code === "ER_DUP_ENTRY" ? "that Project is already linked" : err.message}`);
        }
      }
      res.json({ linked, skipped });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/branches/link-preview", authenticateToken, requireAdmin, requireModule("branches"), async (req: any, res) => {
    try {
      if (!(await needProjectsEdit(req, res))) return;
      const { pairs, skipped } = await candidatePairs();
      const staff = await staffByBranch();
      res.json({
        pairs: pairs.map(({ branch, project }) => ({
          branch_id: Number(branch.id),
          branch_name: branch.branch_name,
          project_id: Number(project.id),
          project_name: project.project_name,
          staff: staff.active.get(Number(branch.id)) || 0,
          their_branch_users: staff.byBranchMode.get(Number(branch.id)) || 0,
          name_differs: branch.branch_name !== project.project_name
        })),
        skipped
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/branches/link-by-name", authenticateToken, requireAdmin, requireModule("branches"), async (req: any, res) => {
    try {
      if (!(await needProjectsEdit(req, res))) return;
      const asked: any[] = Array.isArray(req.body?.pairs) ? req.body.pairs : [];
      if (!asked.length) return res.status(400).json({ error: "Nothing to link." });
      // Checked again now: only pairs that are still valid (same name, both free) go through.
      const { pairs } = await candidatePairs();
      const valid = new Map(pairs.map((p) => [`${p.branch.id}:${p.project.id}`, p]));
      let linked = 0;
      const skipped: string[] = [];
      for (const a of asked) {
        const p = valid.get(`${Number(a?.branch_id)}:${Number(a?.project_id)}`);
        if (!p) {
          skipped.push(`Branch ${Number(a?.branch_id)} / Project ${Number(a?.project_id)}: no longer a free exact-name match`);
          continue;
        }
        try {
          await queryDB("UPDATE branches SET project_id = ? WHERE id = ? AND project_id IS NULL", [p.project.id, p.branch.id]);
          // One map pin for both, never overwriting an existing one: the side without a pin takes the other's.
          if (hasPin(p.branch) && !hasPin(p.project)) {
            await queryDB("UPDATE projects SET location_lat = ?, location_lng = ?, location_label = ?, location_radius = ? WHERE id = ?", [
              p.branch.location_lat, p.branch.location_lng, p.branch.location_label ?? null, p.branch.location_radius ?? null, p.project.id
            ]);
          } else if (hasPin(p.project) && !hasPin(p.branch)) {
            await queryDB("UPDATE branches SET location_lat = ?, location_lng = ?, location_label = ?, location_radius = ? WHERE id = ?", [
              p.project.location_lat, p.project.location_lng, p.project.location_label ?? null, p.project.location_radius ?? null, p.branch.id
            ]);
          }
          linked++;
        } catch (err: any) {
          skipped.push(`${p.branch.branch_name}: ${err.code === "ER_DUP_ENTRY" ? "that Project is already linked" : err.message}`);
        }
      }
      res.json({ linked, skipped });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Archive ----------------------------------------------------------
  app.put("/api/branches/:id/archive", authenticateToken, requireAdmin, requireModule("branches"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const archived = req.body?.archived !== false;
      const rows: any[] = await queryDB("SELECT * FROM branches WHERE id = ?", [id]);
      if (!rows.length) return res.status(404).json({ error: "Branch not found" });
      if (archived) {
        const n: any[] = await queryDB("SELECT COUNT(*) AS n FROM all_employees WHERE is_active = 1 AND branch_id = ?", [id]);
        const people = Number(n[0]?.n || 0);
        if (people > 0) {
          return res.status(409).json({ error: `${people} active employee${people === 1 ? " is" : "s are"} still on this Branch. Move them to another Branch (Merge) before archiving it.`, active_employees: people });
        }
      }
      await queryDB("UPDATE branches SET is_archived = ? WHERE id = ?", [archived ? 1 : 0, id]);
      res.json({ success: true, archived });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/projects/:id/archive", authenticateToken, requireAdmin, requireModule("projects"), requireModuleLayer("projects", "edit_add"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const archived = req.body?.archived !== false;
      const rows: any[] = await queryDB("SELECT id FROM projects WHERE id = ?", [id]);
      if (!rows.length) return res.status(404).json({ error: "Project not found" });
      await queryDB("UPDATE projects SET is_archived = ? WHERE id = ?", [archived ? 1 : 0, id]);
      res.json({ success: true, archived });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Merge a duplicate Branch into the real one ----------------------
  async function mergePlan(fromId: number, intoId: number) {
    const branches: any[] = await queryDB("SELECT * FROM branches");
    const from = branches.find((b) => Number(b.id) === fromId);
    const into = branches.find((b) => Number(b.id) === intoId);
    const blocked: string[] = [];
    if (!from || !into) return { from, into, blocked: ["Branch not found."], people: [] as any[], refs: { team_rules: 0, office_machines: 0, sims: 0 }, typeDiffers: false };
    if (fromId === intoId) blocked.push("Pick a different Branch to move the people into.");
    if (from.project_id && into.project_id) blocked.push(`Both Branches are linked to a Project ("${from.branch_name}" and "${into.branch_name}"). Unlink one of them first.`);
    const people: any[] =
      (await queryDB(
        "SELECT id, user_id, branch, branch_id FROM all_employees WHERE branch_id = ? OR (branch_id IS NULL AND LOWER(TRIM(branch)) = LOWER(TRIM(?)))",
        [fromId, from.branch_name]
      )) || [];
    const count = async (sql: string, p: any[]) => Number(((await queryDB(sql, p).catch(() => [{ n: 0 }])) as any[])[0]?.n || 0);
    const refs = {
      team_rules: await count("SELECT COUNT(*) AS n FROM department_team_auto WHERE LOWER(TRIM(branch)) = LOWER(TRIM(?))", [from.branch_name]),
      office_machines: await count("SELECT COUNT(*) AS n FROM zk_devices WHERE LOWER(TRIM(branch)) = LOWER(TRIM(?))", [from.branch_name]),
      sims: await count("SELECT COUNT(*) AS n FROM mobile_sims WHERE LOWER(TRIM(duty_location)) = LOWER(TRIM(?))", [from.branch_name])
    };
    return { from, into, blocked, people, refs, typeDiffers: from.branch_type !== into.branch_type };
  }

  // Moving people changes their Branch (and maybe their calendar) — it needs the Employees module's Edit/Add too.
  const needEmployeesEdit = async (req: any, res: any): Promise<boolean> => {
    if (!(await hasModuleLayer(req.user, "employees", "edit_add"))) {
      res.status(403).json({ error: "Moving people to another Branch needs Employees Edit/Add permission. Ask your Superadmin to grant it." });
      return false;
    }
    return true;
  };

  app.get("/api/branches/:id/merge-preview", authenticateToken, requireAdmin, requireModule("branches"), async (req: any, res) => {
    try {
      if (!(await needEmployeesEdit(req, res))) return;
      const plan = await mergePlan(Number(req.params.id), Number(req.query.into));
      if (!plan.from || !plan.into) return res.status(404).json({ error: "Branch not found" });
      const active = plan.people.length
        ? Number(((await queryDB("SELECT COUNT(*) AS n FROM all_employees WHERE is_active = 1 AND (branch_id = ? OR (branch_id IS NULL AND LOWER(TRIM(branch)) = LOWER(TRIM(?))))", [plan.from.id, plan.from.branch_name])) as any[])[0]?.n || 0)
        : 0;
      res.json({
        from: { id: Number(plan.from.id), name: plan.from.branch_name, type: plan.from.branch_type, project_id: plan.from.project_id ? Number(plan.from.project_id) : null },
        into: { id: Number(plan.into.id), name: plan.into.branch_name, type: plan.into.branch_type, project_id: plan.into.project_id ? Number(plan.into.project_id) : null },
        employees: plan.people.length,
        active_employees: active,
        type_differs: plan.typeDiffers,
        text_copies: plan.refs,
        blocked: plan.blocked
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/branches/:id/merge", authenticateToken, requireAdmin, requireModule("branches"), async (req: any, res) => {
    try {
      if (!(await needEmployeesEdit(req, res))) return;
      const fromId = Number(req.params.id);
      const intoId = Number(req.body?.into_id);
      const plan = await mergePlan(fromId, intoId);
      if (!plan.from || !plan.into) return res.status(404).json({ error: "Branch not found" });
      if (plan.blocked.length) return res.status(400).json({ error: plan.blocked.join(" ") });
      if (plan.typeDiffers && plan.people.length && req.body?.acknowledge_calendar_change !== true) {
        return res.status(409).json({
          error: `"${plan.from.branch_name}" is ${plan.from.branch_type === "project_site" ? "Project Side" : "Head Office"} and "${plan.into.branch_name}" is ${plan.into.branch_type === "project_site" ? "Project Side" : "Head Office"}: the ${plan.people.length} people moved will follow the other Weekend / Holiday calendar. Confirm to go on.`,
          needs_calendar_confirmation: true
        });
      }
      const today = todayInDhaka();
      const intoName = String(plan.into.branch_name);
      let moved = 0;
      for (const e of plan.people) {
        try {
          // Each person's change is written to their history, like an Edit Employee save would.
          await recordEmployeeEditHistory(queryDB, {
            employeeId: Number(e.id),
            before: { branch: e.branch, branch_id: e.branch_id },
            after: { branch: intoName, branch_id: Number(plan.into.id) },
            trackedFields: ["branch", "branch_id"],
            actionBy: req.user?.id ?? null,
            today
          });
        } catch {
          // the history is best effort; the move itself still goes on
        }
        await queryDB("UPDATE all_employees SET branch = ?, branch_id = ? WHERE id = ?", [intoName, plan.into.id, e.id]);
        moved++;
      }
      await syncDivision(queryDB, { branchIds: [Number(plan.into.id)] }).catch(() => {});
      // The name copies kept as text follow, the same ones a Branch rename reaches.
      const fromName = String(plan.from.branch_name);
      await queryDB("UPDATE department_team_auto SET branch = ? WHERE LOWER(TRIM(branch)) = LOWER(TRIM(?))", [intoName, fromName]).catch(() => {});
      await queryDB("UPDATE zk_devices SET branch = ? WHERE LOWER(TRIM(branch)) = LOWER(TRIM(?))", [intoName, fromName]).catch(() => {});
      await queryDB("UPDATE mobile_sims SET duty_location = ? WHERE LOWER(TRIM(duty_location)) = LOWER(TRIM(?))", [intoName, fromName]).catch(() => {});
      // A Project link moves with the people when the real Branch has none.
      if (plan.from.project_id && !plan.into.project_id) {
        await queryDB("UPDATE branches SET project_id = NULL WHERE id = ?", [plan.from.id]);
        await queryDB("UPDATE branches SET project_id = ? WHERE id = ?", [plan.from.project_id, plan.into.id]);
      }
      // The emptied Branch is archived, never deleted: its row stays for the record.
      await queryDB("UPDATE branches SET is_archived = 1 WHERE id = ?", [plan.from.id]);
      res.json({ success: true, moved, archived_branch_id: Number(plan.from.id) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Set Division from Branch (one-off for people already saved) ----------
  // An Employee's Division is the type of their Branch (BranchDivision.ts). This
  // previews and then applies that to everyone who has a Branch; people with no
  // Branch keep their Division. Every change is written to the person's history.
  async function divisionPlan() {
    const rows: any[] =
      (await queryDB(
        "SELECT e.id, e.name, e.employee_id, e.division, e.branch_id, b.branch_name, b.branch_type FROM all_employees e JOIN branches b ON b.id = e.branch_id ORDER BY e.name"
      )) || [];
    const noBranch = Number(((await queryDB("SELECT COUNT(*) AS n FROM all_employees WHERE branch_id IS NULL").catch(() => [{ n: 0 }])) as any[])[0]?.n || 0);
    const changes = rows
      .map((r) => ({ ...r, want: divisionOfBranchType(r.branch_type) }))
      .filter((r) => String(r.division || "") !== r.want);
    return { total_with_branch: rows.length, no_branch: noBranch, changes };
  }

  app.get("/api/branches/division-preview", authenticateToken, requireAdmin, requireModule("branches"), async (req: any, res) => {
    try {
      if (!(await needEmployeesEdit(req, res))) return;
      const plan = await divisionPlan();
      const from: Record<string, number> = {};
      for (const c of plan.changes) {
        const k = `${String(c.division || "").trim() || "(empty)"} → ${c.want}`;
        from[k] = (from[k] || 0) + 1;
      }
      res.json({
        total_with_branch: plan.total_with_branch,
        no_branch: plan.no_branch,
        will_change: plan.changes.length,
        already_right: plan.total_with_branch - plan.changes.length,
        summary: Object.entries(from).sort((a, b) => b[1] - a[1]).map(([change, count]) => ({ change, count })),
        sample: plan.changes.slice(0, 15).map((c) => ({ name: c.name, employee_id: c.employee_id, branch: c.branch_name, from: c.division || "", to: c.want }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/branches/division-sync", authenticateToken, requireAdmin, requireModule("branches"), async (req: any, res) => {
    try {
      if (!(await needEmployeesEdit(req, res))) return;
      const plan = await divisionPlan();
      const today = todayInDhaka();
      let changed = 0;
      for (const c of plan.changes) {
        try {
          await recordEmployeeEditHistory(queryDB, {
            employeeId: Number(c.id),
            before: { division: c.division },
            after: { division: c.want },
            trackedFields: ["division"],
            actionBy: req.user?.id ?? null,
            today
          });
        } catch {
          // the history is best effort; the change itself still goes on
        }
        await queryDB("UPDATE all_employees SET division = ? WHERE id = ?", [c.want, c.id]);
        changed++;
      }
      res.json({ success: true, changed, no_branch: plan.no_branch });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
