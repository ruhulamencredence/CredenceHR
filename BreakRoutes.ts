/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Break Time — employees start and end their breaks from the app; HR sees
// who is on a break, each day's total and who went over the allowance.
//
//   break_settings   per company: minutes of break allowed a day and how many
//                    breaks a day (companyScope.ts OWN_TABLES).
//   employee_breaks  one row per break: started_at, ended_at (NULL while on
//                    it). Follows the login (USER_TABLES). open_flag is 1 on
//                    the break still going and NULL otherwise, with a UNIQUE
//                    key, so an account can never have two breaks open — even
//                    with two taps at the same moment.
//
// Access:
//   Self Service -> Break Time: users.can_take_break, OFF by default, toggled
//   in Module Access. Start / end own breaks, see own day.
//   Admin Panel module "break_time" — layer "read" sees the report and who is
//   on a break now; layer "break_manage" (explicit-only) changes the rules and
//   ends a break someone forgot to end.

import type { Express } from "express";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export interface RegisterBreakRoutesDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModuleLayer: any;
  hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
  queryDB: QueryDB;
  todayInDhaka: () => string;
}

export const DEFAULT_BREAK_SETTINGS = { allowed_minutes: 60, max_breaks: 3 };

export async function ensureBreakSchema(dbPool: any): Promise<void> {
  const run = async (label: string, sql: string, ignore: string[] = []) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (!ignore.includes(err.code)) console.warn(`⚠️ Break Time (${label}): ${err.message}`);
    }
  };
  await run("users.can_take_break", "ALTER TABLE users ADD COLUMN can_take_break TINYINT(1) NOT NULL DEFAULT 0", ["ER_DUP_FIELDNAME"]);
  await run(
    "break_settings",
    `CREATE TABLE IF NOT EXISTS break_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      allowed_minutes INT NOT NULL DEFAULT ${DEFAULT_BREAK_SETTINGS.allowed_minutes},
      max_breaks INT NOT NULL DEFAULT ${DEFAULT_BREAK_SETTINGS.max_breaks},
      updated_by INT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_break_settings_company (company_id)
    )`
  );
  await run(
    "employee_breaks",
    `CREATE TABLE IF NOT EXISTS employee_breaks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      break_date DATE NOT NULL,
      started_at DATETIME NOT NULL,
      ended_at DATETIME NULL,
      minutes INT NULL,
      note VARCHAR(255) NULL,
      open_flag TINYINT NULL,
      ended_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_employee_breaks_open (user_id, open_flag),
      INDEX idx_employee_breaks_day (break_date, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 62;
const dayStr = (v: any) => (v instanceof Date ? v.toLocaleDateString("en-CA") : String(v || "").slice(0, 10));
const daysBetween = (from: string, to: string) => Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86400000);
// Whole minutes of a break; one still going counts up to now.
const MINUTES_SQL = "COALESCE(b.minutes, CEIL(TIMESTAMPDIFF(SECOND, b.started_at, NOW()) / 60))";

export function registerBreakRoutes(app: Express, deps: RegisterBreakRoutesDeps) {
  const { authenticateToken, requireAdmin, requireModuleLayer, hasModuleLayer, queryDB, todayInDhaka } = deps;
  const canRead = [authenticateToken, requireAdmin, requireModuleLayer("break_time", "read")];
  const canManage = [authenticateToken, requireAdmin, requireModuleLayer("break_time", "break_manage")];
  const fail = (res: any, err: any) => res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

  // Self Service switch (users.can_take_break); a Superadmin always.
  const requireBreakAccess = async (req: any, res: any, next: any) => {
    try {
      const rows: any[] = (await queryDB("SELECT role, can_take_break, is_onboarding FROM users WHERE id = ?", [req.user.id])) || [];
      const u = rows[0];
      if (u && (u.role === "superadmin" || (Number(u.can_take_break) === 1 && !Number(u.is_onboarding)))) return next();
      res.status(403).json({ error: "Break Time isn't turned on for your account. Ask your Superadmin." });
    } catch (err: any) {
      fail(res, err);
    }
  };

  async function settings(): Promise<{ allowed_minutes: number; max_breaks: number }> {
    const rows: any[] = (await queryDB("SELECT allowed_minutes, max_breaks FROM break_settings LIMIT 1").catch(() => [])) || [];
    return rows[0] ? { allowed_minutes: Number(rows[0].allowed_minutes), max_breaks: Number(rows[0].max_breaks) } : { ...DEFAULT_BREAK_SETTINGS };
  }

  async function myDay(userId: number) {
    const today = todayInDhaka();
    const [rules, rows] = await Promise.all([
      settings(),
      queryDB(
        `SELECT b.id, b.started_at, b.ended_at, b.note, b.open_flag, ${MINUTES_SQL} AS minutes,
                TIMESTAMPDIFF(SECOND, b.started_at, COALESCE(b.ended_at, NOW())) AS seconds
           FROM employee_breaks b WHERE b.user_id = ? AND (b.break_date = ? OR b.open_flag = 1) ORDER BY b.started_at`,
        [userId, today]
      )
    ]);
    const breaks = (rows || []).map((r: any) => ({
      id: Number(r.id),
      started_at: r.started_at,
      ended_at: r.ended_at,
      note: r.note || null,
      open: Number(r.open_flag) === 1,
      minutes: Number(r.minutes) || 0,
      // So the page's running clock doesn't depend on the phone's own clock.
      seconds: Math.max(0, Number(r.seconds) || 0)
    }));
    const used = breaks.reduce((n: number, b: any) => n + b.minutes, 0);
    return {
      today,
      rules,
      breaks,
      open: breaks.find((b: any) => b.open) || null,
      used_minutes: used,
      remaining_minutes: Math.max(0, rules.allowed_minutes - used),
      over_minutes: Math.max(0, used - rules.allowed_minutes)
    };
  }

  // ---- Self Service ----
  app.get("/api/breaks/me", authenticateToken, requireBreakAccess, async (req: any, res) => {
    try {
      res.json(await myDay(Number(req.user.id)));
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/breaks/start", authenticateToken, requireBreakAccess, async (req: any, res) => {
    try {
      const userId = Number(req.user.id);
      const day = await myDay(userId);
      if (day.open) throw bad("You are already on a break. End it first.", 409);
      if (day.breaks.length >= day.rules.max_breaks) {
        throw bad(`You have taken all ${day.rules.max_breaks} break${day.rules.max_breaks === 1 ? "" : "s"} allowed today.`);
      }
      const note = String(req.body?.note || "").trim().slice(0, 255) || null;
      try {
        await queryDB("INSERT INTO employee_breaks (user_id, break_date, started_at, note, open_flag) VALUES (?, ?, NOW(), ?, 1)", [userId, day.today, note]);
      } catch (err: any) {
        // A second tap at the same moment: the UNIQUE open_flag key refused it.
        if (err?.code === "ER_DUP_ENTRY") throw bad("You are already on a break. End it first.", 409);
        throw err;
      }
      res.json(await myDay(userId));
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/breaks/end", authenticateToken, requireBreakAccess, async (req: any, res) => {
    try {
      const userId = Number(req.user.id);
      const r: any = await queryDB(
        `UPDATE employee_breaks
            SET ended_at = NOW(), minutes = GREATEST(1, CEIL(TIMESTAMPDIFF(SECOND, started_at, NOW()) / 60)), open_flag = NULL
          WHERE user_id = ? AND open_flag = 1`,
        [userId]
      );
      if (typeof r?.affectedRows === "number" && r.affectedRows === 0) throw bad("You are not on a break.", 409);
      res.json(await myDay(userId));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Admin Panel -> Break Time ----
  app.get("/api/break-settings", ...canRead, async (_req: any, res) => {
    try {
      res.json(await settings());
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/break-settings", ...canManage, async (req: any, res) => {
    try {
      const allowed = Math.round(Number(req.body?.allowed_minutes));
      const max = Math.round(Number(req.body?.max_breaks));
      if (!Number.isFinite(allowed) || allowed < 1 || allowed > 600) throw bad("Allowed break minutes must be between 1 and 600.");
      if (!Number.isFinite(max) || max < 1 || max > 20) throw bad("Breaks a day must be between 1 and 20.");
      await queryDB(
        `INSERT INTO break_settings (allowed_minutes, max_breaks, updated_by) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE allowed_minutes = VALUES(allowed_minutes), max_breaks = VALUES(max_breaks), updated_by = VALUES(updated_by)`,
        [allowed, max, req.user.id]
      );
      res.json(await settings());
    } catch (err) {
      fail(res, err);
    }
  });

  // Every break in from..to (at most MAX_RANGE_DAYS), with one summary row
  // per person per day, and who is on a break right now.
  app.get("/api/breaks/report", ...canRead, async (req: any, res) => {
    try {
      const today = todayInDhaka();
      const from = DATE_RE.test(String(req.query.from || "")) ? String(req.query.from) : today;
      const to = DATE_RE.test(String(req.query.to || "")) ? String(req.query.to) : from;
      if (from > to || daysBetween(from, to) >= MAX_RANGE_DAYS) throw bad(`Pick at most ${MAX_RANGE_DAYS} days.`);
      const rules = await settings();
      const rows: any[] =
        (await queryDB(
          `SELECT b.id, b.user_id, b.break_date, b.started_at, b.ended_at, b.note, b.open_flag, b.ended_by, ${MINUTES_SQL} AS minutes,
                  u.name AS user_name, e.employee_id AS employee_code, e.name AS employee_name, e.department, e.designation
             FROM employee_breaks b
             JOIN users u ON u.id = b.user_id
             LEFT JOIN all_employees e ON e.user_id = b.user_id
            WHERE b.break_date BETWEEN ? AND ? OR b.open_flag = 1
            ORDER BY b.break_date DESC, u.name, b.started_at`,
          [from, to]
        )) || [];
      const seen = new Set<number>();
      const breaks = rows
        .filter((r) => !seen.has(Number(r.id)) && seen.add(Number(r.id)))
        .map((r) => ({
          id: Number(r.id),
          user_id: Number(r.user_id),
          name: r.employee_name || r.user_name,
          employee_code: r.employee_code || null,
          department: r.department || null,
          designation: r.designation || null,
          date: dayStr(r.break_date),
          started_at: r.started_at,
          ended_at: r.ended_at,
          note: r.note || null,
          open: Number(r.open_flag) === 1,
          ended_by_hr: !!r.ended_by,
          minutes: Number(r.minutes) || 0
        }));
      const inRange = breaks.filter((b) => b.date >= from && b.date <= to);
      const days = new Map<string, any>();
      for (const b of inRange) {
        const k = `${b.user_id}|${b.date}`;
        const d =
          days.get(k) ||
          days
            .set(k, { user_id: b.user_id, name: b.name, employee_code: b.employee_code, department: b.department, date: b.date, count: 0, minutes: 0, open: false })
            .get(k);
        d.count++;
        d.minutes += b.minutes;
        d.open = d.open || b.open;
      }
      const summary = [...days.values()].map((d) => ({ ...d, over_minutes: Math.max(0, d.minutes - rules.allowed_minutes) }));
      res.json({
        from,
        to,
        today,
        rules,
        // Shows the Rules tab and the End buttons.
        can_manage: await hasModuleLayer(req.user, "break_time", "break_manage"),
        breaks: inRange,
        summary,
        on_break_now: breaks.filter((b) => b.open)
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // A break someone forgot to end: HR ends it now, or at the time given
  // (HH:MM on the break's own day, after it started and not in the future).
  app.post("/api/breaks/:id/end", ...canManage, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const rows: any[] = (await queryDB("SELECT id, break_date, started_at FROM employee_breaks WHERE id = ? AND open_flag = 1", [id])) || [];
      if (!rows.length) throw bad("This break has already ended, or wasn't found.", 404);
      const at = String(req.body?.ended_at || "").trim();
      let endSql = "NOW()";
      const params: any[] = [];
      if (at) {
        if (!/^\d{2}:\d{2}$/.test(at)) throw bad("End time must be HH:MM.");
        endSql = "TIMESTAMP(?, ?)";
        params.push(dayStr(rows[0].break_date), `${at}:00`);
        const check: any[] = await queryDB(`SELECT ${endSql} > started_at AS after_start, ${endSql} <= NOW() AS not_future FROM employee_breaks WHERE id = ?`, [
          ...params,
          ...params,
          id
        ]);
        if (!Number(check[0]?.after_start)) throw bad("The end time must be after the break started.");
        if (!Number(check[0]?.not_future)) throw bad("The end time can't be in the future.");
      }
      const r: any = await queryDB(
        `UPDATE employee_breaks
            SET ended_at = ${endSql}, minutes = GREATEST(1, CEIL(TIMESTAMPDIFF(SECOND, started_at, ${endSql}) / 60)), open_flag = NULL, ended_by = ?
          WHERE id = ? AND open_flag = 1`,
        [...params, ...params, req.user.id, id]
      );
      if (typeof r?.affectedRows === "number" && r.affectedRows === 0) throw bad("This break has already ended.", 409);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });
}
