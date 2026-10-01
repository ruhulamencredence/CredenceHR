/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Server Profiles (Admin Panel -> Servers for managing it, Superadmin-only;
// GlobalSidebar's "Set Server" for using it, any signed-in account) — split
// into its own file from day one, same reasoning as
// ConveyanceBillClaimRoutes.ts / PayrollRoutes.ts / AssetManagementRoutes.ts:
// server.ts is already huge, so new features go in their own module and are
// registered from inside startServer() via registerServerProfileRoutes(),
// reusing that request's authenticateToken/requireSuperAdmin/queryDB rather
// than a second Express app or DB connection.
//
// What this is for: the app (both the Web build and the Android APK — see
// capacitor.config.ts's `server.url` remote mode) is always loaded live from
// a real server. This table is the single, centrally managed CATALOG of
// known deployments (Head Office, a specific client site, a test server,
// ...) a Superadmin maintains from the WEB Admin Panel -> Servers
// (ServerProfilesPanel.tsx). Any signed-in account (not just Superadmin) can
// fetch this list — everyday employees need it too, to point their device at
// their own company's server — via GlobalSidebar's "Set Server" ->
// ServerSwitcherModal.tsx, which navigates the WebView there
// (window.location.href) rather than keeping any separate "active server"
// bookkeeping on the device (see src/lib/api.ts).
//
// Bootstrapping note: a device still needs to already be pointed at SOME
// reachable backend to log in and fetch this list in the first place (there
// is deliberately no server picker on the Sign In screen) — this table lets
// anyone switch to a DIFFERENT one once they're already connected somewhere,
// not how a brand new device finds its very first server (that's whatever
// URL is baked into capacitor.config.ts at build time).

import type { Express } from "express";

interface ServerProfileRouteDeps {
  authenticateToken: any;
  // Only for the write routes below (add/edit/delete) — same convention as
  // User Management's promote/demote and Module Access actions: never
  // granted through requireModule, since this isn't a grantable Admin Panel
  // module. Reading the list (GET, further down) is open to anyone signed in.
  requireSuperAdmin: any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
}

export async function ensureServerProfilesSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS server_profiles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        url VARCHAR(255) NOT NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure server_profiles table exists: " + err.message);
  }
}

// Mirrors src/lib/api.ts's normalizeApiBase() on the frontend: turns
// whatever a Superadmin typed ("192.168.0.10:3000", "myserver.com") into a
// clean "http(s)://host[:port]" with no trailing slash, defaulting to
// http:// (a LAN IP almost never has a TLS certificate) when no scheme was
// given.
function normalizeUrl(input: string): string {
  const trimmed = (input || "").trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

export function registerServerProfileRoutes(app: Express, deps: ServerProfileRouteDeps) {
  const { authenticateToken, requireSuperAdmin, queryDB } = deps;

  // GET is open to any signed-in account (not just Superadmin) — every
  // employee's device needs to be able to fetch this list to pick which
  // company/deployment server it talks to (see GlobalSidebar's "Set Server").
  // Only adding/editing/removing entries (below) stays Superadmin-only.
  app.get("/api/server-profiles", authenticateToken, async (req, res) => {
    try {
      const rows = await queryDB("SELECT id, name, url, created_at, updated_at FROM server_profiles ORDER BY name ASC");
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/server-profiles", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      const url = normalizeUrl(String(req.body?.url || ""));
      if (!name) return res.status(400).json({ error: "Server name is required." });
      if (!url) return res.status(400).json({ error: "Server IP/URL is required." });

      const result = await queryDB(
        "INSERT INTO server_profiles (name, url, created_by) VALUES (?, ?, ?)",
        [name, url, req.user.id]
      );
      res.status(201).json({ id: result.insertId, name, url });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/server-profiles/:id", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT id FROM server_profiles WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Server not found." });

      const name = String((req.body as any)?.name || "").trim();
      const url = normalizeUrl(String((req.body as any)?.url || ""));
      if (!name) return res.status(400).json({ error: "Server name is required." });
      if (!url) return res.status(400).json({ error: "Server IP/URL is required." });

      await queryDB("UPDATE server_profiles SET name = ?, url = ? WHERE id = ?", [name, url, id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/server-profiles/:id", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      await queryDB("DELETE FROM server_profiles WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
