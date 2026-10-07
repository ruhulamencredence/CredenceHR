/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Projects routes (list, all, create, edit, delete), moved out of server.ts unchanged.
// The shared helpers they use are passed in by startServer().

import type { Express } from "express";

export interface RegisterProjectRoutesDeps {
  authenticateToken: any;
  queryDB: any;
  requireAdmin: any;
  requireModule: any;
  requireModuleLayer: any;
}

export function registerProjectRoutes(app: Express, deps: RegisterProjectRoutesDeps) {
  const { authenticateToken, queryDB, requireAdmin, requireModule, requireModuleLayer } = deps;
  // 2. Projects CRUD
  // Admins see every project. Regular users only see the projects the Admin has
  // explicitly granted them access to via user_project_permissions (Admin Panel ->
  // Users -> Manage Projects). A user with no permissions granted sees none yet.
  app.get("/api/projects", authenticateToken, async (req: any, res) => {
    try {
      const projects = await queryDB("SELECT * FROM projects ORDER BY project_name ASC");
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
      const projects = await queryDB("SELECT * FROM projects ORDER BY project_name ASC");
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

      const result = await queryDB(
        "INSERT INTO projects (project_name, location_lat, location_lng, location_label, location_radius, created_by) VALUES (?, ?, ?, ?, ?, ?)",
        [project_name.trim(), location.lat, location.lng, location.label, location.radius, req.user.id]
      );
      res.json({
        id: result.insertId,
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

  app.put("/api/projects/:id", authenticateToken, requireAdmin, requireModule("projects"), requireModuleLayer("projects", "edit_add"), async (req, res) => {
    try {
      const { id } = req.params;
      const { project_name } = req.body;
      if (!project_name) return res.status(400).json({ error: "Project name is required" });
      const location = parseProjectLocation(req.body);
      if ("error" in location) return res.status(400).json({ error: location.error });

      await queryDB(
        "UPDATE projects SET project_name = ?, location_lat = ?, location_lng = ?, location_label = ?, location_radius = ? WHERE id = ?",
        [project_name.trim(), location.lat, location.lng, location.label, location.radius, id]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/projects/:id", authenticateToken, requireAdmin, requireModule("projects"), requireModuleLayer("projects", "delete_trash"), async (req, res) => {
    try {
      const { id } = req.params;
      await queryDB("DELETE FROM user_project_permissions WHERE project_id = ?", [id]);
      await queryDB("DELETE FROM projects WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
