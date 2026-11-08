/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Sidebar -> "360 ERP" — single sign-on hand-off into the separate 360 ERP
// site, following the partner-app SSO flow it specs: THIS server (never the
// browser) calls 360 ERP's POST /v1/service/sso/initiate with this app's own
// API client credentials (X-App-Id/X-App-Secret from .env) plus the
// logged-in account's email/employee_id/name and the end user's real IP,
// gets back a one-time forward_url, and hands that straight back to the
// frontend to open in a new tab. Kept in its own file, same reasoning as
// every other registerXRoutes module — server.ts is already huge.
//
// No local schema of its own: 360 ERP is the one holding the short-lived
// sso_login_requests token, not us.

import type { Express } from "express";

interface Erp360SsoRouteDeps {
  authenticateToken: any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
}

export function registerErp360SsoRoutes(app: Express, deps: Erp360SsoRouteDeps) {
  const { authenticateToken, queryDB } = deps;

  // POST /api/sso/erp360/initiate — the logged-in account clicks "360 ERP" in
  // the Sidebar; the frontend calls this, then window.open()s the returned
  // forward_url. Never exposes ERP360_APP_ID/ERP360_APP_SECRET to the
  // browser — those only ever travel from this server to 360 ERP's server.
  app.post("/api/sso/erp360/initiate", authenticateToken, async (req: any, res) => {
    try {
      const baseUrl = process.env.ERP360_BASE_URL;
      const appId = process.env.ERP360_APP_ID;
      const appSecret = process.env.ERP360_APP_SECRET;
      if (!baseUrl || !appId || !appSecret) {
        return res.status(400).json({
          error: "360 ERP isn't set up on the server yet — set ERP360_BASE_URL/ERP360_APP_ID/ERP360_APP_SECRET in .env, then restart the server."
        });
      }

      const empRows = await queryDB("SELECT employee_id FROM all_employees WHERE user_id = ? LIMIT 1", [req.user.id]);
      const employeeId = empRows[0]?.employee_id || null;

      // The real end user's IP, not this server's own — same reasoning the
      // flow doc gives (a load balancer/proxy sits in front of us the same
      // way it would in front of any partner app).
      const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      const requestIp = forwardedFor || req.socket?.remoteAddress || req.ip || "";

      const initiateUrl = `${baseUrl.replace(/\/+$/, "")}/api/v1/service/sso/initiate`;
      let upstream: Response;
      try {
        upstream = await fetch(initiateUrl, {
          method: "POST",
          headers: {
            "X-App-Id": appId,
            "X-App-Secret": appSecret,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify({
            email: req.user.email || "",
            employee_id: employeeId,
            name: req.user.name || "",
            request_ip: requestIp,
            redirect_path: "/"
          })
        });
      } catch (networkErr: any) {
        return res.status(502).json({ error: "Could not reach 360 ERP: " + networkErr.message });
      }

      const data = await upstream.json().catch(() => ({} as any));
      if (!upstream.ok) {
        // Mirrors the flow doc's own error shapes (401 "message", 422
        // "message" + "errors") — surface whatever message it gave rather
        // than a generic one, so a real validation problem is actionable.
        return res.status(upstream.status).json({ error: data?.message || `360 ERP login could not start (HTTP ${upstream.status}).` });
      }
      if (!data?.forward_url) {
        return res.status(502).json({ error: "360 ERP didn't return a login link. Please try again." });
      }

      res.json({ forward_url: data.forward_url });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Could not start the 360 ERP login." });
    }
  });
}
