/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Which other websites may call this server from a browser (CORS), and the
// security headers every response carries.
//
// CORS_ORIGINS in .env: the addresses other than this server's own that may
// call the API, comma separated (e.g. "https://hr.example.com,https://localhost").
// The website and the app load from this server itself, which is always
// allowed. Left empty, every website is allowed (as before) and the server
// says so on start.

import type { Express } from "express";
import cors from "cors";

const configured = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

export const corsOpen = configured.length === 0;

// An Origin header that is this server's own address (same host and port).
const sameHost = (origin: string, host: string | undefined) => {
  try {
    return !!host && new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
};

export const originAllowed = (origin: string | undefined, host?: string) =>
  !origin || corsOpen || configured.includes(origin.replace(/\/+$/, "")) || sameHost(origin, host);

// For Socket.IO, which checks only the Origin: "*" while CORS is open.
export const socketCorsOrigin = (): string | string[] => (corsOpen ? "*" : configured);

export function installWebSecurity(app: Express) {
  app.disable("x-powered-by");
  if (corsOpen) {
    console.warn("⚠️ CORS_ORIGINS is not set — any website may call this server's API from a browser. Set it in .env (see WebSecurity.ts).");
  }
  app.use(
    cors((req: any, callback: any) => {
      const origin = req.headers.origin as string | undefined;
      // Not allowed: no CORS headers, so the browser keeps the answer from that page.
      callback(null, { origin: corsOpen ? "*" : originAllowed(origin, req.headers.host) ? origin || false : false });
    })
  );
  app.use((req: any, res: any, next: any) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Pages of this server can't be shown inside another website's frame.
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(self)");
    // Over HTTPS (directly or behind Nginx): browsers keep using HTTPS.
    if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=15552000");
    next();
  });
}
