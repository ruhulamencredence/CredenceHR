/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll Module — new self-service section, currently a "Coming Soon"
// placeholder while the actual payroll workflow is designed. Split into its
// own file from day one (same reasoning as ConveyanceBillClaimRoutes.ts,
// AttendanceRoutes.ts, LeaveRoutes.ts, etc. — keeps server.ts from growing
// further) and registered from inside startServer() via
// registerPayrollRoutes(), reusing that request's authenticateToken/queryDB/
// requireModule rather than a second Express app or DB connection.
//
// Permission-gated behind the 'payroll' Admin Panel module from the start —
// a Superadmin always has access, anyone else needs it explicitly granted
// (Admin Panel -> Users -> Module Access). Only one endpoint for now (module
// status, so the frontend's Coming Soon page has something real to call
// instead of a hardcoded string) — more Payroll routes get added here as
// the module is built out, without touching server.ts again.

import type { Express } from "express";

interface PayrollRouteDeps {
  authenticateToken: any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  // Same requireModule(moduleKey) factory every other Admin Panel module
  // uses (server.ts) — a Superadmin always passes; an Admin/User needs the
  // 'payroll' key granted via Admin Panel -> Users -> Module Access.
  requireModule: (moduleKey: "payroll") => any;
}

export function registerPayrollRoutes(app: Express, deps: PayrollRouteDeps) {
  const { authenticateToken, requireModule, queryDB } = deps;

  // Self Service -> Payroll. Permission-gated like every other module: a
  // Superadmin always has access; anyone else only once explicitly granted
  // the 'payroll' module (requireModule handles both — see server.ts).
  app.get("/api/payroll/status", authenticateToken, requireModule("payroll"), async (req: any, res) => {
    try {
      res.json({ status: "coming_soon" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}