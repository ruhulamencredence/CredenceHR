/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Projects routes (list, all, create, edit, delete), moved out of server.ts unchanged.
// The shared helpers they use are passed in by startServer().

import type { Express } from "express";
import { ENTRY_SCOPES, fillForFromHomes, forGaps, homeProjectsOf } from "./PepmTeam";

export interface RegisterProjectRoutesDeps {
  authenticateToken: any;
  queryDB: any;
  requireAdmin: any;
  requireModule: any;
  requireModuleLayer: any;
  // Yes/no form of the module gate — the Branch part of a Project save needs
  // the Branches section as well (docs/branch-project-rules.md).
  hasModuleLayer?: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
}

export function registerProjectRoutes(app: Express, deps: RegisterProjectRoutesDeps) {
  const { authenticateToken, queryDB, requireAdmin, requireModule, requireModuleLayer, hasModuleLayer } = deps;

  // Each Project carries the Branch it is linked to (Admin Panel -> Branches,
  // branches.project_id) and that Branch's type, so a list can tell a Head
  // Office site from a Project-side one.
  async function withLinkedBranch(projects: any[]) {
    const branches: any[] = await queryDB("SELECT * FROM branches");
    const byProject = new Map<number, any>(branches.filter((b: any) => b.project_id).map((b: any) => [Number(b.project_id), b]));
    return projects.map((p: any) => {
      const b = byProject.get(Number(p.id));
      return { ...p, linked_branch_id: b ? Number(b.id) : null, linked_branch_name: b ? b.branch_name : null, linked_branch_type: b ? b.branch_type : null };
    });
  }
  // 2. Projects CRUD
  // Admins see every project. Regular users only see the projects the Admin has
  // explicitly granted them access to via user_project_permissions (Admin Panel ->
  // Users -> Manage Projects). A user with no permissions granted sees none yet.
  app.get("/api/projects", authenticateToken, async (req: any, res) => {
    try {
      // A retired (archived) Project is left out of pickers; the Admin Panel list asks for all.
      const includeArchived = req.query?.include_archived === "1";
      const projects = (await withLinkedBranch(await queryDB("SELECT * FROM projects ORDER BY project_name ASC"))).filter((p: any) => includeArchived || !Number(p.is_archived));
      if (req.user.role === "admin" || req.user.role === "superadmin") {
        return res.json(projects);
      }
      const perms = await queryDB("SELECT project_id FROM user_project_permissions WHERE user_id = ?", [req.user.id]);
      const allowedIds = new Set(perms.map((p: any) => p.project_id));
      res.json(projects.filter((p: any) => allowedIds.has(p.id)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Every Project, unfiltered by user_project_permissions — used only by
  // Timesheet's "Correct Attendance" picker. A correction is always a request
  // (POST /api/attendance/corrections never checks user_project_permissions
  // either — see that handler), routed through the Approval Workflow same as
  // any other attendance correction, so gating the Project dropdown by
  // check-in permission just blocked Employees with no Project explicitly
  // granted from ever submitting one — the dropdown looked empty ("no
  // project select") even though the request would have gone through
  // approval like normal. Any signed-in account may read this list.
  app.get("/api/projects/all", authenticateToken, async (req: any, res) => {
    try {
      const projects = await withLinkedBranch(await queryDB("SELECT * FROM projects ORDER BY project_name ASC"));
      res.json(projects);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Location fields are optional — a project can be created/edited without ever
  // marking a spot on the map. lat/lng are validated together (both-or-neither,
  // both finite numbers in a real coordinate range) so a bad payload can't save a
  // half-set pin; the free-text label is trimmed and capped, and dropped entirely
  // if lat/lng are absent.
  function parseProjectLocation(body: any): { lat: number | null; lng: number | null; label: string | null; radius: number | null } | { error: string } {
    const hasLat = body.location_lat !== undefined && body.location_lat !== null && body.location_lat !== "";
    const hasLng = body.location_lng !== undefined && body.location_lng !== null && body.location_lng !== "";
    if (!hasLat && !hasLng) return { lat: null, lng: null, label: null, radius: null };
    if (hasLat !== hasLng) return { error: "Both latitude and longitude are required to set a location" };
    const lat = Number(body.location_lat);
    const lng = Number(body.location_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { error: "Invalid map location coordinates" };
    }
    const label = typeof body.location_label === "string" ? body.location_label.trim().slice(0, 255) || null : null;

    let radius: number | null = null;
    const hasRadius = body.location_radius !== undefined && body.location_radius !== null && body.location_radius !== "";
    if (hasRadius) {
      const r = Number(body.location_radius);
      if (!Number.isFinite(r) || r < 10 || r > 50000) {
        return { error: "Radius must be between 10 and 50,000 meters" };
      }
      radius = Math.round(r);
    }
    return { lat, lng, label, radius };
  }

  app.post("/api/projects", authenticateToken, requireAdmin, requireModule("projects"), requireModuleLayer("projects", "edit_add"), async (req: any, res) => {
    try {
      const { project_name } = req.body;
      if (!project_name) return res.status(400).json({ error: "Project name is required" });
      const location = parseProjectLocation(req.body);
      if ("error" in location) return res.status(400).json({ error: location.error });
      // Entry sharing (PepmTeam.ts), "team" unless asked otherwise.
      const scope = req.body.entry_scope !== undefined ? String(req.body.entry_scope) : "team";
      if (!(ENTRY_SCOPES as readonly string[]).includes(scope)) return res.status(400).json({ error: "Entry sharing must be Team, Own entries only or By home project." });

      const result = await queryDB(
        "INSERT INTO projects (project_name, location_lat, location_lng, location_label, location_radius, created_by) VALUES (?, ?, ?, ?, ?, ?)",
        [project_name.trim(), location.lat, location.lng, location.label, location.radius, req.user.id]
      );
      if (scope !== "team") await queryDB("UPDATE projects SET entry_scope = ? WHERE id = ?", [scope, result.insertId]);
      res.json({
        id: result.insertId,
        entry_scope: scope,
        project_name: project_name.trim(),
        location_lat: location.lat,
        location_lng: location.lng,
        location_label: location.label,
        location_radius: location.radius
      });
    } catch (err: any) {
      if (err.code === "ER_DUP_ENTRY" || err.message?.includes("already exists")) {
        return res.status(400).json({ error: "Project already exists" });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Branch part of a Project save (docs/branch-project-rules.md). Optional
  // body fields: branch_type ("head_office" | "project_site") and branch_link
  // ("keep" | "auto" | "none" | a Branch id). Left out, the Project save does
  // exactly what it always did. Checked in full BEFORE anything is written, so
  // a refusal changes nothing. Needs the Branches section as well as the
  // Project's Edit/Add. The Branch rules themselves are the Branch screen's:
  // one Branch per Project, a Branch never linked to two Projects, the type is
  // the Holiday Calendar group, and a new Branch always gets its type said out
  // loud (the API default and the column default disagree).
  type BranchPlan =
    | { error: string; status: number }
    | {
        action: "none" | "keep" | "link" | "create" | "unlink";
        target: any | null; // the Branch the Project ends up with (null when none / to be created)
        unlinkId: number | null; // a different Branch it was linked to, to release
        type: "head_office" | "project_site" | null; // the type to set (only when it changes / is new)
        pin: { lat: number | null; lng: number | null; label: string | null; radius: number | null } | null; // a newly linked Branch's own pin, when the Project has none
      };
  async function planBranchChange(req: any, projectId: number, projectName: string, location: { lat: number | null }): Promise<BranchPlan> {
    const rawType = req.body?.branch_type;
    const rawLink = req.body?.branch_link;
    const hasType = rawType !== undefined && rawType !== null && rawType !== "";
    const hasLink = rawLink !== undefined && rawLink !== null && rawLink !== "";
    if (!hasType && !hasLink) return { action: "none", target: null, unlinkId: null, type: null, pin: null };
    if (!hasModuleLayer || !(await hasModuleLayer(req.user, "branches", "read"))) {
      return { error: "Changing a Project's Branch or its type needs the Branches section. Ask your Superadmin to grant it.", status: 403 };
    }
    if (hasType && rawType !== "head_office" && rawType !== "project_site") return { error: "Branch type must be Head Office or Project Side.", status: 400 };
    const type: "head_office" | "project_site" | null = hasType ? rawType : null;
    const branches: any[] = await queryDB("SELECT * FROM branches");
    const projects: any[] = await queryDB("SELECT id, project_name FROM projects");
    const linked = branches.find((b) => Number(b.project_id) === projectId) || null;
    const projectOf = (b: any) => projects.find((p) => Number(p.id) === Number(b.project_id))?.project_name || "another Project";
    const same = (a: any, b: any) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

    let mode: "keep" | "auto" | "none" | number = "keep";
    if (hasLink) {
      mode = rawLink === "keep" ? "keep" : rawLink === "auto" ? "auto" : rawLink === "none" ? "none" : Number(rawLink);
      if (typeof mode === "number" && (!Number.isInteger(mode) || mode <= 0)) return { error: "Invalid Branch selected.", status: 400 };
    } else if (!linked) {
      mode = "auto"; // a type for a Project with no Branch yet: its own Branch
    }
    if (mode === "auto" && linked) mode = "keep";

    if (mode === "none") {
      return { action: linked ? "unlink" : "none", target: null, unlinkId: linked ? Number(linked.id) : null, type: null, pin: null };
    }
    let target: any | null = linked;
    let action: "keep" | "link" | "create" = "keep";
    let unlinkId: number | null = null;
    if (typeof mode === "number") {
      const b = branches.find((x) => Number(x.id) === mode);
      if (!b) return { error: "Selected Branch not found.", status: 400 };
      if (b.project_id && Number(b.project_id) !== projectId) return { error: `That Branch is already linked to Project "${projectOf(b)}".`, status: 400 };
      if (!linked || Number(linked.id) !== mode) {
        target = b;
        action = "link";
        unlinkId = linked ? Number(linked.id) : null;
      }
    } else if (mode === "auto") {
      const named = branches.find((b) => same(b.branch_name, projectName));
      if (named && named.project_id && Number(named.project_id) !== projectId) return { error: `Branch "${named.branch_name}" is already linked to Project "${projectOf(named)}".`, status: 400 };
      if (named) {
        target = named;
        action = "link";
      } else {
        if (!type) return { error: "Pick Head Office or Project Side for the new Branch.", status: 400 };
        return { action: "create", target: null, unlinkId: null, type, pin: null };
      }
    }
    // A Branch with its own pin keeps it when it is linked to a Project that has none.
    let pin: { lat: number | null; lng: number | null; label: string | null; radius: number | null } | null = null;
    if (action === "link" && target && target.location_lat != null && location.lat == null) {
      pin = { lat: Number(target.location_lat), lng: Number(target.location_lng), label: target.location_label ?? null, radius: target.location_radius != null ? Number(target.location_radius) : null };
    }
    const typeChanges = !!type && !!target && target.branch_type !== type;
    return { action: action === "keep" && !typeChanges ? "keep" : action, target, unlinkId, type: typeChanges ? type : null, pin };
  }

  // How many people follow a Branch's calendar: the number the "change type"
  // confirmation shows.
  app.get("/api/projects/:id/branch-impact", authenticateToken, requireAdmin, requireModule("projects"), requireModuleLayer("projects", "edit_add"), async (req: any, res) => {
    try {
      if (!hasModuleLayer || !(await hasModuleLayer(req.user, "branches", "read"))) return res.status(403).json({ error: "This needs the Branches section." });
      // The Branch the Project has now, or the one about to be picked (?branch_id=).
      const wanted = Number(req.query.branch_id) || 0;
      const all: any[] = await queryDB("SELECT * FROM branches");
      const b = wanted ? all.find((x: any) => Number(x.id) === wanted) : all.find((x: any) => Number(x.project_id) === Number(req.params.id));
      if (!b) return res.json({ branch_id: null, branch_name: null, branch_type: null, employees: 0 });
      const rows: any[] = await queryDB("SELECT COUNT(*) AS n FROM all_employees WHERE branch_id = ?", [b.id]);
      res.json({ branch_id: Number(b.id), branch_name: b.branch_name, branch_type: b.branch_type, employees: Number(rows[0]?.n || 0) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/projects/:id", authenticateToken, requireAdmin, requireModule("projects"), requireModuleLayer("projects", "edit_add"), async (req: any, res) => {
    try {
      const { id } = req.params;
      const { project_name } = req.body;
      if (!project_name) return res.status(400).json({ error: "Project name is required" });
      const location = parseProjectLocation(req.body);
      if ("error" in location) return res.status(400).json({ error: location.error });

      const before: any[] = await queryDB("SELECT * FROM projects WHERE id = ?", [id]);
      // The Branch part (if asked) is checked first: a refusal writes nothing.
      const branchPlan = await planBranchChange(req, Number(id), project_name.trim(), location);
      if ("error" in branchPlan) return res.status(branchPlan.status).json({ error: branchPlan.error });
      const pinned = branchPlan.pin && location.lat == null ? branchPlan.pin : location;
      await queryDB(
        "UPDATE projects SET project_name = ?, location_lat = ?, location_lng = ?, location_label = ?, location_radius = ? WHERE id = ?",
        [project_name.trim(), pinned.lat, pinned.lng, pinned.label, pinned.radius, id]
      );
      // Link / create / unlink the Branch and set its type, before the sync
      // below (which keeps the linked Branch's name and pin in step).
      if (branchPlan.unlinkId) await queryDB("UPDATE branches SET project_id = NULL WHERE id = ?", [branchPlan.unlinkId]);
      if (branchPlan.action === "link" && branchPlan.target) await queryDB("UPDATE branches SET project_id = ? WHERE id = ?", [id, branchPlan.target.id]);
      if (branchPlan.action === "create" && branchPlan.type) {
        const made = await queryDB(
          "INSERT INTO branches (branch_name, branch_type, location_lat, location_lng, location_label, location_radius, created_by, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [project_name.trim(), branchPlan.type, pinned.lat, pinned.lng, pinned.label, pinned.radius, req.user.id, id]
        );
        void made;
      } else if (branchPlan.type && branchPlan.target) {
        await queryDB("UPDATE branches SET branch_type = ? WHERE id = ?", [branchPlan.type, branchPlan.target.id]);
      }
      // Budget rows name their Project in text (budget_items.project_name,
      // matched by name): a new name reaches them too, so the Project's old
      // Budgets keep working.
      let budgetRowsRenamed = 0;
      if (before.length && String(before[0].project_name).trim().toLowerCase() !== project_name.trim().toLowerCase()) {
        const r: any = await queryDB("UPDATE budget_items SET project_name = ? WHERE LOWER(TRIM(project_name)) = LOWER(TRIM(?))", [project_name.trim(), before[0].project_name]);
        budgetRowsRenamed = Number(r?.affectedRows || 0);
      } else if (before.length && String(before[0].project_name) !== project_name.trim()) {
        // Only letter case / spaces changed: still keep the rows' text the same.
        await queryDB("UPDATE budget_items SET project_name = ? WHERE LOWER(TRIM(project_name)) = LOWER(TRIM(?))", [project_name.trim(), before[0].project_name]);
      }
      // Entry sharing (PepmTeam.ts): who sees this Project's PEPM entries.
      let forFilled = 0;
      if (req.body.entry_scope !== undefined) {
        const scope = String(req.body.entry_scope);
        if (!(ENTRY_SCOPES as readonly string[]).includes(scope)) return res.status(400).json({ error: "Entry sharing must be Team, Own entries only or By home project." });
        await queryDB("UPDATE projects SET entry_scope = ? WHERE id = ?", [scope, id]);
        if (scope === "home") forFilled = await fillForFromHomes(queryDB, Number(id));
      }
      // The linked Branch keeps the same map pin, and the same name while the
      // two names still match (see branches.project_id).
      const linked = (await queryDB("SELECT * FROM branches")).find((b: any) => Number(b.project_id) === Number(id));
      if (linked) {
        const nameFollows = before.length > 0 && String(linked.branch_name).trim().toLowerCase() === String(before[0].project_name).trim().toLowerCase();
        const sync = (name: string) =>
          queryDB(
            "UPDATE branches SET branch_name = ?, location_lat = ?, location_lng = ?, location_label = ?, location_radius = ? WHERE id = ?",
            [name, pinned.lat, pinned.lng, pinned.label, pinned.radius, linked.id]
          );
        try {
          await sync(nameFollows ? project_name.trim() : linked.branch_name);
        } catch (err: any) {
          // Another Branch already has that name — keep this one's own.
          if (err.code !== "ER_DUP_ENTRY") throw err;
          await sync(linked.branch_name);
        }
      }
      res.json({ success: true, for_filled: forFilled, budget_rows_renamed: budgetRowsRenamed });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // "By home project" (PepmTeam.ts): entries whose maker works on several
  // Projects, so their For couldn't be filled by itself — the Admin picks
  // one per person. Same permission as editing the Project.
  app.get("/api/projects/:id/for-gaps", authenticateToken, requireAdmin, requireModule("projects"), requireModuleLayer("projects", "edit_add"), async (req, res) => {
    try {
      res.json(await forGaps(queryDB, Number(req.params.id)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/projects/:id/for-fill", authenticateToken, requireAdmin, requireModule("projects"), requireModuleLayer("projects", "edit_add"), async (req, res) => {
    try {
      const projectId = Number(req.params.id);
      const userId = Number(req.body?.user_id);
      const forId = Number(req.body?.for_project_id);
      if (!userId || !forId) return res.status(400).json({ error: "Pick the person and the project." });
      const homes = await homeProjectsOf(queryDB, userId);
      if (!homes.some((h) => h.id === forId)) return res.status(400).json({ error: "That project isn't one of this person's projects." });
      const r: any = await queryDB("UPDATE entries SET for_project_id = ? WHERE project_id = ? AND created_by = ? AND for_project_id IS NULL", [forId, projectId, userId]);
      res.json({ success: true, filled: Number(r?.affectedRows || 0) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/projects/:id", authenticateToken, requireAdmin, requireModule("projects"), requireModuleLayer("projects", "delete_trash"), async (req, res) => {
    try {
      const { id } = req.params;
      // The tables below delete with the Project (ON DELETE CASCADE): a Project
      // that has PEPM entries, attendance or corrections is not deleted — it is
      // archived instead, so its history stays.
      const count = async (sql: string) => Number((((await queryDB(sql, [id]).catch(() => [{ n: 0 }])) as any[])[0] || {}).n || 0);
      const entries = await count("SELECT COUNT(*) AS n FROM entries WHERE project_id = ?");
      const attendance = await count("SELECT COUNT(*) AS n FROM attendance WHERE project_id = ?");
      const corrections = await count("SELECT COUNT(*) AS n FROM attendance_corrections WHERE project_id = ?");
      if (entries + attendance + corrections > 0) {
        return res.status(409).json({
          error: `This Project can't be deleted: it has ${entries} PEPM entr${entries === 1 ? "y" : "ies"}, ${attendance} attendance record${attendance === 1 ? "" : "s"} and ${corrections} attendance correction${corrections === 1 ? "" : "s"}, which would be erased with it. Archive it instead.`,
          entries,
          attendance,
          corrections
        });
      }
      await queryDB("DELETE FROM user_project_permissions WHERE project_id = ?", [id]);
      await queryDB("DELETE FROM projects WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
