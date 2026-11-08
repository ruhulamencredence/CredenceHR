/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Every /api answer is JSON, and the database's own error text never reaches
// a browser:
//   - maskDatabaseErrors (installed before the routes): an { error } that is
//     really a MySQL message ("Out of range value for column 'basic_salary'",
//     "Duplicate entry …", "Unknown column …") is replaced with a short plain
//     one; the original goes to the server log with the route. One the
//     client caused (too long, duplicate, bad reference…) answers 400 / 409.
//   - apiNotFoundAndErrors (installed after every route): an /api address no
//     route answers is a 404 { error } (not the app's web page), a body that
//     isn't valid JSON is a 400 { error } (not Express's HTML error page), a
//     body over the size limit is a 413, and anything else a route throws is
//     a 500 { error } without the details.

import type { Express } from "express";

const DB_ERROR = /\b(ER_[A-Z_]+|SQL syntax|Unknown column|Out of range value|Duplicate entry|Data too long|Incorrect (?:integer|decimal|date|datetime|string) value|cannot be null|doesn't have a default value|foreign key constraint|Table '[^']*' doesn't exist|Deadlock found|Lock wait timeout|ECONNREFUSED|PROTOCOL_CONNECTION_LOST|Too many connections)\b/i;

function plain(message: string): string {
  if (/Duplicate entry/i.test(message)) return "This already exists — it can't be added twice.";
  if (/Out of range value/i.test(message)) return "A number is too large (or too small) for this field.";
  if (/Data too long/i.test(message)) return "A text value is too long for this field.";
  if (/Incorrect (?:integer|decimal|date|datetime|string) value/i.test(message)) return "A value isn't in the right format (number or date).";
  if (/cannot be null|doesn't have a default value/i.test(message)) return "A required value is missing.";
  if (/foreign key constraint/i.test(message)) return "This is still in use elsewhere, or refers to something that no longer exists.";
  if (/Deadlock found|Lock wait timeout/i.test(message)) return "The system was busy — please try again.";
  if (/ECONNREFUSED|PROTOCOL_CONNECTION_LOST|Too many connections/i.test(message)) return "The database isn't reachable right now — please try again shortly.";
  return "Something went wrong on the server. Please try again, or tell IT if it keeps happening.";
}

// A database error caused by what the client sent (too long, wrong format,
// duplicate, a missing or still-used reference) is the client's to fix: a
// route that answered 500 for it is moved to 400 / 409, so it isn't counted
// as a server failure.
function clientStatus(message: string): number | null {
  if (/Duplicate entry|foreign key constraint/i.test(message)) return 409;
  if (/Out of range value|Data too long|Incorrect (?:integer|decimal|date|datetime|string) value|cannot be null|doesn't have a default value/i.test(message)) return 400;
  return null;
}

export function maskDatabaseErrors(app: Express): void {
  app.use("/api", (req: any, res: any, next: any) => {
    const json = res.json.bind(res);
    res.json = (body: any) => {
      if (body && typeof body === "object" && typeof body.error === "string" && DB_ERROR.test(body.error)) {
        console.warn(`⚠️ ${req.method} ${req.originalUrl}: ${body.error}`);
        const fix = res.statusCode >= 500 ? clientStatus(body.error) : null;
        if (fix) res.status(fix);
        body = { ...body, error: plain(body.error) };
      }
      return json(body);
    };
    next();
  });
}

export function apiNotFoundAndErrors(app: Express): void {
  app.use("/api", (req: any, res: any) => {
    res.status(404).json({ error: `No such API address: ${req.method} ${req.originalUrl.split("?")[0]}` });
  });
  // Express error handler (4 arguments): body parsing and anything a route
  // passed to next(err) or threw synchronously.
  app.use((err: any, req: any, res: any, next: any) => {
    if (res.headersSent) return next(err);
    if (!String(req.originalUrl || "").startsWith("/api")) return next(err);
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "The request body isn't valid JSON." });
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "The request is too large." });
    const status = Number(err?.status || err?.statusCode) || 500;
    if (status < 500) return res.status(status).json({ error: err?.expose && err?.message ? String(err.message) : "Bad request." });
    console.warn(`⚠️ ${req.method} ${req.originalUrl}:`, err?.message || err);
    res.status(500).json({ error: plain(String(err?.message || "")) });
  });
}
