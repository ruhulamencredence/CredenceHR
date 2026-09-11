/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Global Calendar (Admin Panel -> Holidays) routes, split out of server.ts on
// purpose — same convention as profileRoutes.ts: server.ts is already huge, so
// new features go in their own module from here on instead of growing it
// further. Registered from inside startServer() via registerHolidayRoutes(),
// reusing that same request's `app`/`authenticateToken`/`requireAdmin`/
// `requireModule`/`queryDB` rather than creating a second Express app or a
// second DB connection.
//
// Purpose: a single, shared calendar of "Weekend" and "Holiday" dates that a
// Superadmin grants specific Admins/Users access to maintain (the "holidays"
// Admin Panel module, alongside every other module in ADMIN_MODULE_KEYS).
// Every signed-in account can READ this calendar (so their own Timesheet can
// show "Weekend"/"Holiday" instead of "Absent"); only accounts granted the
// "holidays" module can add/edit/remove entries. getHolidayMap() below is the
// piece the Monthly/Date-Wise Attendance Reports in server.ts call so a date
// marked here is never counted as an employee being Absent.

import type { Express } from "express";

export type HolidayDayType = "holiday" | "weekend";

export interface HolidayEntry {
  id: number;
  entry_date: string;
  day_type: HolidayDayType;
  title: string;
  created_by: number | null;
  created_at: string;
}

interface HolidayRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  // Same requireModule(moduleKey) factory used by every other Admin Panel
  // module in server.ts — pass "holidays" through it here so a Superadmin can
  // grant/revoke this calendar's WRITE access independently of every other
  // module, exactly like Remote Attendance, Notices, etc.
  requireModule: (moduleKey: "holidays") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
}

// Self-healing migration — same pattern as the other tables in server.ts's
// ensureSchemaMigrations(): CREATE TABLE IF NOT EXISTS means a normal server
// restart is enough to pick this up on an already-running database, no manual
// SQL required. One row per calendar date; UNIQUE(entry_date) keeps a date
// from ever being set twice.
export async function ensureHolidayCalendarSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS holiday_calendar (
        id INT AUTO_INCREMENT PRIMARY KEY,
        entry_date DATE NOT NULL,
        day_type ENUM('holiday', 'weekend') NOT NULL DEFAULT 'holiday',
        title VARCHAR(150) NOT NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_holiday_entry_date (entry_date),
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure holiday_calendar table exists: " + err.message);
  }
}

// Every calendar entry between from/to (inclusive), as a Map keyed by
// "YYYY-MM-DD" for O(1) lookups while looping a month's days. Used by the
// Monthly Attendance Report and Date-Wise Attendance Report in server.ts —
// a date present here is a Weekend/Holiday and must never add to an
// employee's Absent count, whether or not they actually checked in that day.
// Fails soft (empty map) if the table isn't ready yet on a brand-new install,
// same as every other best-effort lookup in this app.
export async function getHolidayMap(
  queryDB: (sql: string, params?: any[]) => Promise<any>,
  from: string,
  to: string
): Promise<Map<string, { day_type: HolidayDayType; title: string }>> {
  const map = new Map<string, { day_type: HolidayDayType; title: string }>();
  try {
    const rows = await queryDB(
      "SELECT entry_date, day_type, title FROM holiday_calendar WHERE entry_date BETWEEN ? AND ?",
      [from, to]
    );
    for (const r of rows) {
      map.set(String(r.entry_date).slice(0, 10), { day_type: r.day_type, title: r.title });
    }
  } catch {
    // holiday_calendar not created yet — report no holidays rather than
    // failing the whole Attendance Report.
  }
  return map;
}

export function registerHolidayRoutes(app: Express, deps: HolidayRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB } = deps;

  // GET /api/holidays?from=YYYY-MM-DD&to=YYYY-MM-DD — every signed-in account
  // may READ the calendar (Timesheet, Attendance Card, etc. all need this to
  // show Weekend/Holiday correctly), regardless of "holidays" module access.
  // Only the write routes below are gated behind that module. Omitting
  // from/to returns the entire calendar (small table, fine to load in full
  // for the Admin Panel's own list view).
  app.get("/api/holidays", authenticateToken, async (req: any, res) => {
    try {
      const from = String(req.query.from || "");
      const to = String(req.query.to || "");
      let rows: any;
      if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        rows = await queryDB(
          "SELECT * FROM holiday_calendar WHERE entry_date BETWEEN ? AND ? ORDER BY entry_date ASC",
          [from, to]
        );
      } else {
        rows = await queryDB("SELECT * FROM holiday_calendar ORDER BY entry_date ASC");
      }
      res.json(rows.map((r: any) => ({ ...r, entry_date: String(r.entry_date).slice(0, 10) })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/holidays — add one Weekend/Holiday date. Gated behind the
  // "holidays" module: a Superadmin grants this via the existing Module
  // Access modal (same one every other tab uses) to whichever Admin/User
  // should be able to maintain the calendar.
  app.post("/api/holidays", authenticateToken, requireAdmin, requireModule("holidays"), async (req: any, res) => {
    try {
      const { entry_date, day_type, title } = req.body || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(entry_date || ""))) {
        return res.status(400).json({ error: "A valid date (YYYY-MM-DD) is required." });
      }
      const type: HolidayDayType = day_type === "weekend" ? "weekend" : "holiday";
      const cleanTitle = String(title || "").trim() || (type === "weekend" ? "Weekend" : "Holiday");

      const existing = await queryDB("SELECT id FROM holiday_calendar WHERE entry_date = ?", [entry_date]);
      if (existing.length > 0) {
        return res.status(409).json({ error: "This date is already set on the calendar." });
      }
      const result: any = await queryDB(
        "INSERT INTO holiday_calendar (entry_date, day_type, title, created_by) VALUES (?, ?, ?, ?)",
        [entry_date, type, cleanTitle, req.user.id]
      );
      res.json({ id: result.insertId, entry_date, day_type: type, title: cleanTitle });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/holidays/bulk-weekly — convenience for the common case ("every
  // Friday is a Weekend"): marks every occurrence of one weekday as "weekend"
  // across a date range in a single call instead of clicking each date one by
  // one. Silently skips any date already on the calendar (e.g. re-running it
  // for a later range, or a date someone already marked a Holiday).
  app.post("/api/holidays/bulk-weekly", authenticateToken, requireAdmin, requireModule("holidays"), async (req: any, res) => {
    try {
      const { from, to, weekday, title } = req.body || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to || ""))) {
        return res.status(400).json({ error: "A valid from/to date range is required." });
      }
      const wd = Number(weekday);
      if (!Number.isInteger(wd) || wd < 0 || wd > 6) {
        return res.status(400).json({ error: "weekday must be 0 (Sunday) through 6 (Saturday)." });
      }
      const cleanTitle = String(title || "").trim() || "Weekend";
      const start = new Date(`${from}T00:00:00Z`);
      const end = new Date(`${to}T00:00:00Z`);
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
        return res.status(400).json({ error: "Invalid date range." });
      }
      const MAX_DAYS = 731; // ~2 years, generous cap so this can't run away
      let inserted = 0;
      for (let d = new Date(start), i = 0; d <= end && i < MAX_DAYS; d.setUTCDate(d.getUTCDate() + 1), i++) {
        if (d.getUTCDay() !== wd) continue;
        const dateStr = d.toISOString().slice(0, 10);
        const existing = await queryDB("SELECT id FROM holiday_calendar WHERE entry_date = ?", [dateStr]);
        if (existing.length > 0) continue;
        await queryDB(
          "INSERT INTO holiday_calendar (entry_date, day_type, title, created_by) VALUES (?, 'weekend', ?, ?)",
          [dateStr, cleanTitle, req.user.id]
        );
        inserted++;
      }
      res.json({ success: true, inserted });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/holidays/:id — edit an entry's type/title. The date itself is
  // immutable here (delete + re-add instead) so this stays a simple one-column
  // update with no risk of colliding with another date's UNIQUE constraint.
  app.put("/api/holidays/:id", authenticateToken, requireAdmin, requireModule("holidays"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const { day_type, title } = req.body || {};
      const type: HolidayDayType = day_type === "weekend" ? "weekend" : "holiday";
      const cleanTitle = String(title || "").trim();
      if (!cleanTitle) return res.status(400).json({ error: "Title is required." });

      const existing = await queryDB("SELECT id FROM holiday_calendar WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Not found." });

      await queryDB("UPDATE holiday_calendar SET day_type = ?, title = ? WHERE id = ?", [type, cleanTitle, id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/holidays/:id — remove a date from the calendar (it goes back
  // to counting as a normal working day for Attendance purposes).
  app.delete("/api/holidays/:id", authenticateToken, requireAdmin, requireModule("holidays"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      await queryDB("DELETE FROM holiday_calendar WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
