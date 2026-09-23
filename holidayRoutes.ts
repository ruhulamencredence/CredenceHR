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

// Which Employee group a calendar entry applies to — driven by
// branches.branch_type via each Employee's all_employees.branch_id (see
// getEmployeeBranchTypeMap below). Two fully independent calendars, not one
// calendar with exceptions: a date can be a Holiday for Head Office and an
// ordinary working day for Project sites, or vice versa, or both, or neither.
export type HolidayAppliesTo = "head_office" | "project_site";

export interface HolidayEntry {
  id: number;
  entry_date: string;
  day_type: HolidayDayType;
  title: string;
  applies_to: HolidayAppliesTo;
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
// SQL required. One row per (calendar date, Employee group) — the same date
// can now have up to two independent rows, one per applies_to, so the
// uniqueness key covers both columns instead of just entry_date.
export async function ensureHolidayCalendarSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS holiday_calendar (
        id INT AUTO_INCREMENT PRIMARY KEY,
        entry_date DATE NOT NULL,
        day_type ENUM('holiday', 'weekend') NOT NULL DEFAULT 'holiday',
        title VARCHAR(150) NOT NULL,
        applies_to ENUM('head_office', 'project_site') NOT NULL DEFAULT 'head_office',
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_holiday_entry_date_group (entry_date, applies_to),
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure holiday_calendar table exists: " + err.message);
  }

  // Everything below is for a database that already had holiday_calendar
  // from before applies_to existed (a single undifferentiated calendar) — a
  // fresh install's CREATE TABLE above already has the final shape, so each
  // of these is a no-op there (column already exists / index already exists
  // / nothing to duplicate).
  try {
    await dbPool.query(`ALTER TABLE holiday_calendar ADD COLUMN applies_to ENUM('head_office', 'project_site') NOT NULL DEFAULT 'head_office'`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add holiday_calendar.applies_to column: " + err.message);
    }
  }
  // The old single-column UNIQUE(entry_date) has to go before the duplicate
  // step below can insert a second row for the same date — it would still
  // reject that as a collision otherwise.
  try {
    await dbPool.query(`ALTER TABLE holiday_calendar DROP INDEX unique_holiday_entry_date`);
  } catch {
    // Already dropped on a previous run, or never existed (fresh install).
  }
  try {
    await dbPool.query(`ALTER TABLE holiday_calendar ADD UNIQUE KEY unique_holiday_entry_date_group (entry_date, applies_to)`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_KEYNAME") {
      console.warn("⚠️ Could not add holiday_calendar's (entry_date, applies_to) unique key: " + err.message);
    }
  }
  // One-time-per-date migration: every pre-existing entry (which the ADD
  // COLUMN above defaulted to 'head_office') gets copied into
  // 'project_site' too, so upgrading never silently drops Project-site
  // Employees' holidays down to zero — an Admin reviews/splits them apart
  // afterwards in Admin Panel -> Holidays, they don't start from a blank
  // calendar. NOT EXISTS keeps this idempotent across repeated startups.
  try {
    await dbPool.query(`
      INSERT INTO holiday_calendar (entry_date, day_type, title, applies_to, created_by)
      SELECT h.entry_date, h.day_type, h.title, 'project_site', h.created_by
      FROM holiday_calendar h
      WHERE h.applies_to = 'head_office'
        AND NOT EXISTS (
          SELECT 1 FROM holiday_calendar h2
          WHERE h2.entry_date = h.entry_date AND h2.applies_to = 'project_site'
        )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not copy existing holiday_calendar entries into the project_site group: " + err.message);
  }
}

// Every Employee's group ('head_office' | 'project_site'), keyed by
// users.id — resolved via all_employees.branch_id -> branches.branch_type.
// An Employee with no Branch assigned yet (branch_id NULL, or no matching
// all_employees row at all — e.g. a login-only account) defaults to
// 'head_office', matching the column defaults used throughout this
// migration, so an unclassified account never silently loses ITS holidays
// either. Full-table SELECTs joined in JS rather than a SQL JOIN — same
// convention this codebase already uses for this shape of lookup (see
// ExitOffboardingRoutes.ts's own comment on why), and the only form the
// in-memory fallback DB's generic-table simulator can parse.
export async function getEmployeeBranchTypeMap(
  queryDB: (sql: string, params?: any[]) => Promise<any>
): Promise<Map<number, HolidayAppliesTo>> {
  const map = new Map<number, HolidayAppliesTo>();
  try {
    // Full-table SELECTs, filtered in JS — the in-memory fallback DB's
    // generic-table simulator only understands `SELECT * FROM <table>`
    // verbatim, not a column-restricted/WHERE-filtered variant.
    const [employees, branches] = await Promise.all([
      queryDB("SELECT * FROM all_employees"),
      queryDB("SELECT * FROM branches")
    ]);
    const branchTypeById = new Map<number, HolidayAppliesTo>(
      branches.map((b: any) => [Number(b.id), (b.branch_type === "project_site" ? "project_site" : "head_office") as HolidayAppliesTo])
    );
    for (const e of employees) {
      if (e.user_id == null) continue;
      const type = e.branch_id != null ? branchTypeById.get(Number(e.branch_id)) : undefined;
      map.set(Number(e.user_id), type || "head_office");
    }
  } catch {
    // Best-effort — an empty map just means every caller falls back to
    // 'head_office' for everyone below, same as an unclassified account.
  }
  return map;
}

// Every calendar entry between from/to (inclusive), as a Map keyed by
// "YYYY-MM-DD" for O(1) lookups while looping a month's days. Used by the
// Monthly Attendance Report and Date-Wise Attendance Report in server.ts —
// a date present here is a Weekend/Holiday and must never add to an
// employee's Absent count, whether or not they actually checked in that day.
// Fails soft (empty map) if the table isn't ready yet on a brand-new install,
// same as every other best-effort lookup in this app.
// Fetches the WHOLE calendar and filters in JS, rather than a
// column-restricted/BETWEEN-filtered SQL query — small table (a company's
// holidays/weekends span at most a few years), and the only form the
// in-memory fallback DB's generic-table simulator can parse (it pattern-
// matches `SELECT * FROM <table>` verbatim). Every route below shares this
// one fetch shape for the same reason — see fetchAllHolidayRows.
async function fetchAllHolidayRows(queryDB: (sql: string, params?: any[]) => Promise<any>): Promise<any[]> {
  try {
    return await queryDB("SELECT * FROM holiday_calendar");
  } catch {
    // holiday_calendar not created yet — report no holidays rather than
    // failing the whole Attendance Report/Admin Panel page.
    return [];
  }
}

export async function getHolidayMap(
  queryDB: (sql: string, params?: any[]) => Promise<any>,
  from: string,
  to: string,
  appliesTo: HolidayAppliesTo
): Promise<Map<string, { day_type: HolidayDayType; title: string }>> {
  const map = new Map<string, { day_type: HolidayDayType; title: string }>();
  const rows = await fetchAllHolidayRows(queryDB);
  for (const r of rows) {
    if (r.applies_to !== appliesTo) continue;
    const d = String(r.entry_date).slice(0, 10);
    if (d < from || d > to) continue;
    map.set(d, { day_type: r.day_type, title: r.title });
  }
  return map;
}

// Both groups' maps in one call — the shape every Attendance Report/Payroll
// call site below actually needs, since a single run covers Employees from
// both groups at once.
export async function getHolidayMapsByGroup(
  queryDB: (sql: string, params?: any[]) => Promise<any>,
  from: string,
  to: string
): Promise<Record<HolidayAppliesTo, Map<string, { day_type: HolidayDayType; title: string }>>> {
  const rows = await fetchAllHolidayRows(queryDB);
  const build = (appliesTo: HolidayAppliesTo) => {
    const map = new Map<string, { day_type: HolidayDayType; title: string }>();
    for (const r of rows) {
      if (r.applies_to !== appliesTo) continue;
      const d = String(r.entry_date).slice(0, 10);
      if (d < from || d > to) continue;
      map.set(d, { day_type: r.day_type, title: r.title });
    }
    return map;
  };
  return { head_office: build("head_office"), project_site: build("project_site") };
}

export function registerHolidayRoutes(app: Express, deps: HolidayRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB } = deps;

  // GET /api/holidays?from=YYYY-MM-DD&to=YYYY-MM-DD&applies_to=head_office|project_site
  // — every signed-in account may READ the calendar (Timesheet, Attendance
  // Card, etc. all need this to show Weekend/Holiday correctly), regardless
  // of "holidays" module access. Only the write routes below are gated
  // behind that module. Omitting from/to returns the whole date range;
  // omitting applies_to returns BOTH groups together — the Admin Panel's
  // own list view wants everything at once (it splits the two into tabs
  // client-side), while Timesheet/the Dashboard widget pass their own
  // resolved group (see GET /api/my-holiday-group below) to only ever see
  // holidays that actually apply to them.
  app.get("/api/holidays", authenticateToken, async (req: any, res) => {
    try {
      const from = String(req.query.from || "");
      const to = String(req.query.to || "");
      const appliesTo = parseAppliesTo(req.query.applies_to);
      const hasRange = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
      let rows = await fetchAllHolidayRows(queryDB);
      if (appliesTo) rows = rows.filter((r: any) => r.applies_to === appliesTo);
      if (hasRange) {
        rows = rows.filter((r: any) => {
          const d = String(r.entry_date).slice(0, 10);
          return d >= from && d <= to;
        });
      }
      rows = [...rows].sort((a: any, b: any) => String(a.entry_date).localeCompare(String(b.entry_date)));
      res.json(rows.map((r: any) => ({ ...r, entry_date: String(r.entry_date).slice(0, 10) })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/my-holiday-group — which calendar (Head Office or Project
  // site) the CALLING account's own holidays/weekends come from, so
  // Timesheet.tsx/HolidayCalendarWidget.tsx can fetch GET /api/holidays
  // with the right applies_to instead of guessing or showing both groups
  // mixed together. Every signed-in account may read this about themselves
  // (not gated behind the "holidays" module — this isn't calendar-editing,
  // just "which one am I").
  app.get("/api/my-holiday-group", authenticateToken, async (req: any, res) => {
    try {
      const branchTypeMap = await getEmployeeBranchTypeMap(queryDB);
      res.json({ applies_to: branchTypeMap.get(Number(req.user.id)) || "head_office" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Both /api/holidays and /api/holidays/bulk-weekly below accept applies_to
  // in the body — 'head_office' or 'project_site' — and always require a
  // real value (no silent default here, unlike the column's own DB default,
  // since that DB default exists only to keep pre-existing rows valid during
  // the migration, not to let a client skip picking a group).
  function parseAppliesTo(v: any): HolidayAppliesTo | null {
    return v === "head_office" || v === "project_site" ? v : null;
  }

  // POST /api/holidays — add one Weekend/Holiday date, for one Employee
  // group. Gated behind the "holidays" module: a Superadmin grants this via
  // the existing Module Access modal (same one every other tab uses) to
  // whichever Admin/User should be able to maintain the calendar.
  app.post("/api/holidays", authenticateToken, requireAdmin, requireModule("holidays"), async (req: any, res) => {
    try {
      const { entry_date, day_type, title } = req.body || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(entry_date || ""))) {
        return res.status(400).json({ error: "A valid date (YYYY-MM-DD) is required." });
      }
      const appliesTo = parseAppliesTo(req.body?.applies_to);
      if (!appliesTo) return res.status(400).json({ error: "applies_to must be 'head_office' or 'project_site'." });
      const type: HolidayDayType = day_type === "weekend" ? "weekend" : "holiday";
      const cleanTitle = String(title || "").trim() || (type === "weekend" ? "Weekend" : "Holiday");

      const allRows = await fetchAllHolidayRows(queryDB);
      const dupe = allRows.some((r: any) => String(r.entry_date).slice(0, 10) === entry_date && r.applies_to === appliesTo);
      if (dupe) {
        return res.status(409).json({ error: "This date is already set on this calendar." });
      }
      const result: any = await queryDB(
        "INSERT INTO holiday_calendar (entry_date, day_type, title, applies_to, created_by) VALUES (?, ?, ?, ?, ?)",
        [entry_date, type, cleanTitle, appliesTo, req.user.id]
      );
      res.json({ id: result.insertId, entry_date, day_type: type, title: cleanTitle, applies_to: appliesTo });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/holidays/bulk-weekly — convenience for the common case ("every
  // Friday is a Weekend"): marks every occurrence of one weekday as "weekend"
  // across a date range, for one Employee group, in a single call instead of
  // clicking each date one by one. Silently skips any date already on that
  // group's calendar (e.g. re-running it for a later range, or a date
  // someone already marked a Holiday).
  app.post("/api/holidays/bulk-weekly", authenticateToken, requireAdmin, requireModule("holidays"), async (req: any, res) => {
    try {
      const { from, to, weekday, title } = req.body || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to || ""))) {
        return res.status(400).json({ error: "A valid from/to date range is required." });
      }
      const appliesTo = parseAppliesTo(req.body?.applies_to);
      if (!appliesTo) return res.status(400).json({ error: "applies_to must be 'head_office' or 'project_site'." });
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
      // Fetched once before the loop (not re-queried per date) — a fixed
      // snapshot is fine here since a weekday-stepped range never revisits
      // the same date twice within one run, and this is also the only form
      // the in-memory fallback DB's generic-table simulator can parse.
      const existingDates = new Set(
        (await fetchAllHolidayRows(queryDB))
          .filter((r: any) => r.applies_to === appliesTo)
          .map((r: any) => String(r.entry_date).slice(0, 10))
      );
      let inserted = 0;
      for (let d = new Date(start), i = 0; d <= end && i < MAX_DAYS; d.setUTCDate(d.getUTCDate() + 1), i++) {
        if (d.getUTCDay() !== wd) continue;
        const dateStr = d.toISOString().slice(0, 10);
        if (existingDates.has(dateStr)) continue;
        // day_type passed as a real param ('weekend') rather than a SQL
        // literal — every value here is now a `?` placeholder, which is
        // also what the in-memory fallback DB's generic INSERT handler
        // requires (it maps params to columns purely by position).
        await queryDB(
          "INSERT INTO holiday_calendar (entry_date, day_type, title, applies_to, created_by) VALUES (?, ?, ?, ?, ?)",
          [dateStr, "weekend", cleanTitle, appliesTo, req.user.id]
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

      const existing = await queryDB("SELECT * FROM holiday_calendar WHERE id = ?", [id]);
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

  // GET /api/today-overview — the two things an employee plans their day
  // around: whether today is off / when the next non-working day is, and who
  // else is out on approved Leave right now.
  //
  // Readable by every signed-in account, same as GET /api/holidays above.
  // Who is out today is an ordinary "who's around" question rather than an HR
  // record, so this returns ONLY the person's name and the date they're back
  // — never the leave type, purpose, remarks or balance, which stay between
  // them and their approvers.
  app.get("/api/today-overview", authenticateToken, async (req: any, res) => {
    try {
      // Local Y/M/D rather than toISOString(), which is UTC and rolls back a
      // calendar day for timezones ahead of it (e.g. Bangladesh) — that would
      // leave this reading yesterday's answer every morning until 6am.
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

      // Which calendar applies to the account asking — Head Office and
      // Project site Employees can have a different "is today off" answer.
      const branchTypeMap = await getEmployeeBranchTypeMap(queryDB);
      const myGroup: HolidayAppliesTo = branchTypeMap.get(Number(req.user.id)) || "head_office";

      const allHolidayRows = await fetchAllHolidayRows(queryDB);
      const myGroupRows = allHolidayRows
        .filter((r: any) => r.applies_to === myGroup)
        .map((r: any) => ({ ...r, entry_date: String(r.entry_date).slice(0, 10) }))
        .sort((a: any, b: any) => a.entry_date.localeCompare(b.entry_date));
      const todayRows = myGroupRows.filter((r: any) => r.entry_date === today);
      const nextRows = myGroupRows.filter((r: any) => r.entry_date > today).slice(0, 1);

      const leaveRows = await queryDB(
        `SELECT l.user_id, l.end_date, u.name
         FROM leave_applications l
         JOIN users u ON u.id = l.user_id
         WHERE l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ?`,
        [today, today]
      );

      // One person can hold two approved applications that both cover today
      // (e.g. a range extended by a second request), which would list them
      // twice — keep one row each, carrying the later return date.
      const byUser = new Map<number, { user_id: number; name: string; until: string }>();
      for (const row of leaveRows) {
        const userId = Number(row.user_id);
        const until = String(row.end_date).slice(0, 10);
        const existing = byUser.get(userId);
        if (!existing || until > existing.until) {
          byUser.set(userId, { user_id: userId, name: row.name, until });
        }
      }
      const onLeave = Array.from(byUser.values()).sort((a, b) => a.name.localeCompare(b.name));

      const next = nextRows[0]
        ? {
            date: String(nextRows[0].entry_date).slice(0, 10),
            day_type: nextRows[0].day_type,
            title: nextRows[0].title,
            days_away: Math.max(
              0,
              Math.round(
                (new Date(String(nextRows[0].entry_date).slice(0, 10)).getTime() - new Date(today).getTime()) / 86400000
              )
            )
          }
        : null;

      res.json({
        today,
        today_off: todayRows[0] ? { day_type: todayRows[0].day_type, title: todayRows[0].title } : null,
        next_off: next,
        // Capped so a company-wide holiday season can't turn this into a huge
        // payload; the true figure is reported alongside it either way.
        on_leave_today: onLeave.slice(0, 50),
        on_leave_count: onLeave.length
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
