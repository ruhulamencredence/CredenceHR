/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Transfer (Admin Panel -> Employees -> "Transfer / Change Role")
// — kept in its own file, same reasoning as profileRoutes.ts /
// ConveyanceBillClaimRoutes.ts / PayrollRoutes.ts / AssetManagementRoutes.ts:
// server.ts is already huge, so new features go in their own module and are
// registered from inside startServer() via registerEmployeeTransferRoutes(),
// reusing that request's authenticateToken/requireAdmin/requireModule/queryDB
// rather than a second Express app or DB connection.
//
// Data model (see ensureEmployeeTransferSchema below):
//   employee_transfers — one row per Department/Designation/Supervisor change
//                        made to an all_employees row, keeping the FROM and
//                        TO value of each field so the Employee's job history
//                        stays auditable instead of being silently overwritten.
//                        Written by the Transfer modal AND by a plain "Edit
//                        Employee" save (PUT /api/employees/:id) whenever that
//                        save changes Department/Designation — see
//                        recordEmployeeEditHistory below.
//   employee_change_log — one row per OTHER field (name, email, phone, branch,
//                        job status, addresses…) changed by an "Edit Employee"
//                        save: field_name / old_value / new_value / who / when.
//
// A transfer always does two things together: it records the history row AND
// updates all_employees' own current department/designation (and, when a new
// Supervisor is picked, the employee_supervisors table already owned by the
// Employees module's Supervisor tab — this reuses that table instead of
// tracking supervisor history a second time). queryDB() only ever runs one
// statement at a time (no transaction wrapper exists in this codebase — see
// server.ts), so these are sequential awaits guarded by a try/catch, the same
// pattern POST /api/employees' own create_login branch already uses for its
// own multi-step write (create the login, then the Employee row).
//
// `applied` (added to employee_transfers below): a Transfer dated TODAY or
// earlier takes effect immediately, same as before. One dated in the FUTURE
// is still recorded right away (so it shows in Transfer History and the
// Effective Date is on record), but is deliberately left un-applied — the
// Employee's live Department/Designation/Supervisor on all_employees is only
// overwritten once that date actually arrives. Otherwise a future-dated
// Transfer would immediately blank out the employee's CURRENT, still-correct
// position ahead of time. There's no cron/scheduler in this codebase, so the
// "date arrived" check runs lazily — applyDueEmployeeTransfers() is called
// from GET /api/employees (server.ts) and from this file's own routes below,
// promoting any now-due row to all_employees right before it's read.

import type { Express } from "express";

interface EmployeeTransferRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  // Same requireModule(moduleKey) factory every other Admin Panel module
  // uses (server.ts) — this feature lives under the existing 'employees'
  // module, not a new one, since it's just another action on the same
  // Employee Directory row.
  requireModule: (moduleKey: "employees") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  // Today's calendar date in Asia/Dhaka as "YYYY-MM-DD" — server.ts's own
  // todayInDhaka(), passed in rather than reimplemented here so a Transfer's
  // "has the Effective Date arrived yet?" check always agrees with the rest
  // of the app (MySQL's own CURDATE() would use the DB server's timezone,
  // which this codebase deliberately avoids for exactly this kind of
  // date-boundary comparison — see server.ts's own comment on todayInDhaka).
  todayInDhaka: () => string;
}

// Self-healing migration — same pattern as ensureAssetManagementSchema /
// ensurePayrollSchema: CREATE TABLE IF NOT EXISTS means a normal server
// restart is enough to pick this up on an already-running database, no
// manual SQL required. Called from server.ts's ensureSchemaMigrations()
// alongside every other table.
export async function ensureEmployeeTransferSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS employee_transfers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        from_department_id INT NULL,
        from_department_name VARCHAR(255) NULL,
        to_department_id INT NULL,
        to_department_name VARCHAR(255) NULL,
        from_designation VARCHAR(255) NULL,
        to_designation VARCHAR(255) NULL,
        from_supervisor_id INT NULL,
        to_supervisor_id INT NULL,
        effective_date DATE NULL,
        reason VARCHAR(255) NULL,
        action_by INT NULL,
        -- Whether this row's TO values have been written to all_employees
        -- yet. Defaults to 1 (already applied) so a fresh install's history
        -- is never treated as pending; new rows explicitly set 0 when their
        -- Effective Date is still in the future — see applyTransferEffect /
        -- applyDueEmployeeTransfers below.
        applied TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
        FOREIGN KEY (from_supervisor_id) REFERENCES all_employees(id) ON DELETE SET NULL,
        FOREIGN KEY (to_supervisor_id) REFERENCES all_employees(id) ON DELETE SET NULL,
        FOREIGN KEY (action_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure employee_transfers table exists: " + err.message);
  }

  // Self-healing column addition for an already-running database that
  // created this table before `applied` existed — ignore the error if the
  // column is already there (older MySQL doesn't support "ADD COLUMN IF NOT
  // EXISTS" reliably, so this is the portable approach used everywhere else
  // in this codebase, see server.ts's own migrations). DEFAULT 1 marks every
  // pre-existing row as already-applied, which they were — the old code
  // always wrote straight to all_employees regardless of Effective Date.
  try {
    await dbPool.query(`ALTER TABLE employee_transfers ADD COLUMN applied TINYINT(1) NOT NULL DEFAULT 1`);
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") {
      console.warn("⚠️ Could not add employee_transfers.applied column: " + err.message);
    }
  }

  // Field-level audit trail for every other "Edit Employee" change (Department
  // /Designation go to employee_transfers above so the existing Transfer
  // History view keeps showing them). Values are stored as text — a DATE is
  // its 'YYYY-MM-DD' string (pool uses dateStrings), a boolean is "0"/"1".
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS employee_change_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        field_name VARCHAR(100) NOT NULL,
        old_value TEXT NULL,
        new_value TEXT NULL,
        action_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_employee_change_log_employee (employee_id, created_at),
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
        FOREIGN KEY (action_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure employee_change_log table exists: " + err.message);
  }
}

// Writes one transfer's TO values to the live Employee row and, if a new
// Supervisor is being set, the Supervisor tab's own history table — the
// actual "make it real" step. Shared by POST /transfer below (Effective Date
// already here or in the past → apply immediately) and by
// applyDueEmployeeTransfers (a previously future-dated row whose date has
// now arrived). Re-reads the currently-active direct Supervisor itself
// rather than trusting a value captured earlier, since time may have passed
// (and other transfers may have landed) between when a row was recorded and
// when it's actually applied.
async function applyTransferEffect(
  queryDB: (sql: string, params?: any[]) => Promise<any>,
  row: {
    employee_id: number;
    to_department_id: number | null;
    to_department_name: string | null;
    to_designation: string | null;
    to_supervisor_id: number | null;
    effective_date: string;
  }
): Promise<void> {
  await queryDB(
    `UPDATE all_employees
     SET department_id = ?, department = ?, designation = ?, designation_effective_date = ?
     WHERE id = ?`,
    [row.to_department_id, row.to_department_name, row.to_designation, row.effective_date, row.employee_id]
  );

  if (row.to_supervisor_id) {
    const currentSupervisorRows = await queryDB(
      "SELECT supervisor_id FROM employee_supervisors WHERE employee_id = ? AND is_direct = 1 ORDER BY effective_date DESC, id DESC LIMIT 1",
      [row.employee_id]
    );
    const currentSupervisorId = currentSupervisorRows.length > 0 ? currentSupervisorRows[0].supervisor_id : null;
    if (row.to_supervisor_id !== currentSupervisorId) {
      await queryDB(
        "UPDATE employee_supervisors SET is_direct = 0 WHERE employee_id = ? AND is_direct = 1",
        [row.employee_id]
      );
      await queryDB(
        "INSERT INTO employee_supervisors (employee_id, supervisor_id, effective_date, is_direct) VALUES (?, ?, ?, 1)",
        [row.employee_id, row.to_supervisor_id, row.effective_date]
      );
    }
  }
}

// Self-healing "catch up" sweep — promotes any recorded Transfer whose
// Effective Date has now arrived (applied = 0 AND effective_date <= today)
// to all_employees, in employee/date/id order so an employee with more than
// one now-due row ends up on the chronologically-last one. No cron exists in
// this codebase, so this is called lazily, right before any place that shows
// an Employee's CURRENT position — GET /api/employees (server.ts) and this
// file's own routes below.
export async function applyDueEmployeeTransfers(
  queryDB: (sql: string, params?: any[]) => Promise<any>,
  today: string
): Promise<void> {
  try {
    const due = await queryDB(
      `SELECT * FROM employee_transfers
       WHERE applied = 0 AND effective_date <= ?
       ORDER BY employee_id ASC, effective_date ASC, id ASC`,
      [today]
    );
    for (const row of due) {
      await applyTransferEffect(queryDB, row);
      await queryDB("UPDATE employee_transfers SET applied = 1 WHERE id = ?", [row.id]);
    }
  } catch (err: any) {
    console.warn("⚠️ Could not apply due employee transfers: " + err.message);
  }
}

const normHistoryValue = (v: any): string | null =>
  v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim();

// Called by PUT /api/employees/:id (server.ts) right BEFORE it overwrites the
// all_employees row, so a plain "Edit Employee" save leaves the same audit
// trail the Transfer modal does:
//   - Department and/or Designation changed → one employee_transfers row
//     (FROM/TO snapshot, applied = 1 because the edit takes effect
//     immediately, reason marks it as a direct edit). Shows up in the
//     existing Transfer History view with no frontend change.
//   - Any other tracked field changed → one employee_change_log row per field.
// `before` is the all_employees row as read from the DB; `after` uses the same
// column names with the already-normalized values about to be written.
// Nothing is written when nothing changed. Sequential awaits, no transaction
// (none exists in this codebase) — history first, same order as POST /transfer.
export async function recordEmployeeEditHistory(
  queryDB: (sql: string, params?: any[]) => Promise<any>,
  opts: {
    employeeId: number;
    before: Record<string, any>;
    after: Record<string, any>;
    trackedFields: string[];
    actionBy: number | null;
    today: string;
  }
): Promise<{ transferRecorded: boolean; fieldsLogged: number }> {
  const { employeeId, before, after, trackedFields, actionBy, today } = opts;

  const deptChanged =
    normHistoryValue(before.department_id) !== normHistoryValue(after.department_id) ||
    normHistoryValue(before.department) !== normHistoryValue(after.department);
  const desigChanged = normHistoryValue(before.designation) !== normHistoryValue(after.designation);

  let transferRecorded = false;
  if (deptChanged || desigChanged) {
    // Use the form's Designation Effective Date only if the admin actually
    // changed it in this save — otherwise it's just the old, stale value
    // echoed back and today is the honest date.
    const submittedDate = normHistoryValue(after.designation_effective_date);
    const effectiveDate =
      desigChanged && submittedDate && submittedDate !== normHistoryValue(before.designation_effective_date)
        ? submittedDate
        : today;
    await queryDB(
      `INSERT INTO employee_transfers
       (employee_id, from_department_id, from_department_name, to_department_id, to_department_name,
        from_designation, to_designation, from_supervisor_id, to_supervisor_id, effective_date, reason, action_by, applied)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 1)`,
      [
        employeeId,
        before.department_id ?? null,
        before.department ?? null,
        after.department_id ?? null,
        after.department ?? null,
        before.designation ?? null,
        after.designation ?? null,
        effectiveDate,
        "Edited via Employee form",
        actionBy
      ]
    );
    transferRecorded = true;
  }

  const changed = trackedFields.filter(
    (f) => normHistoryValue(before[f]) !== normHistoryValue(after[f])
  );
  if (changed.length > 0) {
    const placeholders = changed.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params: any[] = [];
    for (const f of changed) {
      params.push(employeeId, f, normHistoryValue(before[f]), normHistoryValue(after[f]), actionBy);
    }
    await queryDB(
      `INSERT INTO employee_change_log (employee_id, field_name, old_value, new_value, action_by) VALUES ${placeholders}`,
      params
    );
  }

  return { transferRecorded, fieldsLogged: changed.length };
}

export function registerEmployeeTransferRoutes(app: Express, deps: EmployeeTransferRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB, todayInDhaka } = deps;

  // Same department resolution POST/PUT /api/employees already does
  // (server.ts's resolveEmployeeDepartment) — kept as a small local copy
  // here since that one isn't exported. A department_id that no longer
  // matches any row just falls back to "no structured Department", same as
  // the original.
  async function resolveDepartment(
    departmentId: number | null
  ): Promise<{ department_id: number | null; department_name: string | null }> {
    if (departmentId) {
      const rows = await queryDB("SELECT id, name FROM departments WHERE id = ?", [departmentId]);
      if (rows.length > 0) return { department_id: Number(rows[0].id), department_name: rows[0].name };
    }
    return { department_id: null, department_name: null };
  }

  // History list for the "Transfer History" view on an Employee row —
  // newest first, with Department/Supervisor names joined in for display
  // (mirrors GET /api/employees/:id/supervisors' own join style).
  app.get(
    "/api/employees/:id/transfers",
    authenticateToken,
    requireAdmin,
    requireModule("employees"),
    async (req, res) => {
      try {
        // Catch up first — if an earlier future-dated Transfer's Effective
        // Date has since arrived, promote it before this employee's history
        // (and the `applied` flag shown against each row) is read.
        await applyDueEmployeeTransfers(queryDB, todayInDhaka());

        const id = Number(req.params.id);
        const rows = await queryDB(
          `SELECT t.*,
                  fs.name AS from_supervisor_name,
                  ts.name AS to_supervisor_name,
                  u.name AS action_by_name
           FROM employee_transfers t
           LEFT JOIN all_employees fs ON fs.id = t.from_supervisor_id
           LEFT JOIN all_employees ts ON ts.id = t.to_supervisor_id
           LEFT JOIN users u ON u.id = t.action_by
           WHERE t.employee_id = ?
           ORDER BY t.effective_date DESC, t.id DESC`,
          [id]
        );
        res.json(rows.map((r: any) => ({ ...r, applied: !!Number(r.applied) })));
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  // All-employees Change History (Admin Panel -> Employees -> "Change
  // History") — Department/Designation changes (employee_transfers) and
  // every other field edit (employee_change_log) for EVERY employee, newest
  // first, filterable by employee name/ID (q), kind (job | fields), and a
  // created_at date range (from/to, 'YYYY-MM-DD'). Each source is fetched up
  // to `limit` rows; if either was cut off, entries older than the newest
  // cut-off point are dropped so the merged list never has a gap in the
  // middle, and hasMore tells the UI to offer "Load older" (a bigger limit).
  app.get(
    "/api/employee-change-history",
    authenticateToken,
    requireAdmin,
    requireModule("employees"),
    async (req, res) => {
      try {
        await applyDueEmployeeTransfers(queryDB, todayInDhaka());

        const kind = req.query.kind === "job" || req.query.kind === "fields" ? String(req.query.kind) : "all";
        const q = String(req.query.q || "").trim();
        const isDate = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
        const from = isDate(req.query.from) ? String(req.query.from) : null;
        const to = isDate(req.query.to) ? String(req.query.to) : null;
        // Validated integer, interpolated (not bound) — same as every other
        // LIMIT in this codebase.
        const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 100, 1), 500);

        const buildWhere = (alias: string) => {
          const conds: string[] = [];
          const params: any[] = [];
          if (q) {
            conds.push("(e.name LIKE ? OR e.employee_id LIKE ?)");
            params.push(`%${q}%`, `%${q}%`);
          }
          if (from) {
            conds.push(`DATE(${alias}.created_at) >= ?`);
            params.push(from);
          }
          if (to) {
            conds.push(`DATE(${alias}.created_at) <= ?`);
            params.push(to);
          }
          return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
        };

        let transfers: any[] = [];
        let changes: any[] = [];

        if (kind !== "fields") {
          const w = buildWhere("t");
          transfers = await queryDB(
            `SELECT t.*,
                    e.name AS employee_name,
                    e.employee_id AS employee_code,
                    fs.name AS from_supervisor_name,
                    ts.name AS to_supervisor_name,
                    u.name AS action_by_name
             FROM employee_transfers t
             JOIN all_employees e ON e.id = t.employee_id
             LEFT JOIN all_employees fs ON fs.id = t.from_supervisor_id
             LEFT JOIN all_employees ts ON ts.id = t.to_supervisor_id
             LEFT JOIN users u ON u.id = t.action_by
             ${w.where}
             ORDER BY t.created_at DESC, t.id DESC
             LIMIT ${limit}`,
            w.params
          );
        }
        if (kind !== "job") {
          const w = buildWhere("c");
          changes = await queryDB(
            `SELECT c.*,
                    e.name AS employee_name,
                    e.employee_id AS employee_code,
                    u.name AS action_by_name
             FROM employee_change_log c
             JOIN all_employees e ON e.id = c.employee_id
             LEFT JOIN users u ON u.id = c.action_by
             ${w.where}
             ORDER BY c.created_at DESC, c.id DESC
             LIMIT ${limit}`,
            w.params
          );
        }

        // A source that returned exactly `limit` rows may have more behind
        // it. Its oldest row's timestamp is where the merged view stops
        // being complete; rows at that exact timestamp may be a partial
        // group, so they go too (strictly newer only).
        const truncatedOldest: string[] = [];
        if (transfers.length >= limit) truncatedOldest.push(String(transfers[transfers.length - 1].created_at));
        if (changes.length >= limit) truncatedOldest.push(String(changes[changes.length - 1].created_at));
        const hasMore = truncatedOldest.length > 0;
        if (hasMore) {
          const cutoff = truncatedOldest.reduce((a, b) => (a > b ? a : b));
          transfers = transfers.filter((r) => String(r.created_at) > cutoff);
          changes = changes.filter((r) => String(r.created_at) > cutoff);
        }

        res.json({
          transfers: transfers.map((r: any) => ({ ...r, applied: !!Number(r.applied) })),
          changes,
          hasMore
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  // Field-level "Edit Employee" history (everything except Department/
  // Designation, which live in the Transfer History list above) — newest
  // first. See recordEmployeeEditHistory.
  app.get(
    "/api/employees/:id/change-log",
    authenticateToken,
    requireAdmin,
    requireModule("employees"),
    async (req, res) => {
      try {
        const id = Number(req.params.id);
        const rows = await queryDB(
          `SELECT c.*, u.name AS action_by_name
           FROM employee_change_log c
           LEFT JOIN users u ON u.id = c.action_by
           WHERE c.employee_id = ?
           ORDER BY c.created_at DESC, c.id DESC
           LIMIT 500`,
          [id]
        );
        res.json(rows);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  // Transfer / Change Role — Admin Panel -> Employees -> row action. Changes
  // Department and/or Designation (job title) and, optionally, Supervisor,
  // recording a full FROM/TO snapshot in employee_transfers before touching
  // the live all_employees row.
  app.post(
    "/api/employees/:id/transfer",
    authenticateToken,
    requireAdmin,
    requireModule("employees"),
    async (req: any, res) => {
      try {
        // Catch up first — an earlier future-dated Transfer for this same
        // employee may have come due since it was recorded; apply it before
        // reading `current` below, so this new Transfer's FROM values (and
        // the Supervisor lookup further down) reflect the true current state
        // rather than a stale, not-yet-applied one.
        await applyDueEmployeeTransfers(queryDB, todayInDhaka());

        const id = Number(req.params.id);
        const employeeRows = await queryDB("SELECT * FROM all_employees WHERE id = ?", [id]);
        if (employeeRows.length === 0) return res.status(404).json({ error: "Employee not found" });
        const current = employeeRows[0];

        const { to_department_id, to_designation, to_supervisor_id, effective_date, reason } = req.body;

        if (!effective_date || !String(effective_date).trim()) {
          return res.status(400).json({ error: "Effective date is required." });
        }
        const effectiveDateStr = String(effective_date).trim();
        // A Transfer dated today or earlier takes effect right away, same as
        // before. One dated in the future is recorded but left un-applied —
        // see applyTransferEffect / applyDueEmployeeTransfers above — so the
        // employee's CURRENT Department/Designation/Supervisor stays correct
        // until that date actually arrives.
        const isDue = effectiveDateStr <= todayInDhaka();

        const newSupervisorId = to_supervisor_id ? Number(to_supervisor_id) : null;
        if (newSupervisorId === id) {
          return res.status(400).json({ error: "An employee cannot be their own supervisor." });
        }
        if (newSupervisorId) {
          const supExists = await queryDB("SELECT id FROM all_employees WHERE id = ?", [newSupervisorId]);
          if (supExists.length === 0) {
            return res.status(400).json({ error: "Selected supervisor was not found in the Employee list." });
          }
        }

        // Nothing typed means "keep as-is" — a Transfer only needs to touch
        // Department, only Designation, or both; Supervisor is optional on
        // top of either.
        const toDept =
          to_department_id !== undefined && to_department_id !== null && to_department_id !== ""
            ? await resolveDepartment(Number(to_department_id))
            : { department_id: current.department_id ?? null, department_name: current.department ?? null };
        const toDesignation =
          to_designation && String(to_designation).trim() ? String(to_designation).trim() : current.designation;

        // Current direct Supervisor on file (employee_supervisors), if any —
        // this table already IS the Employees module's Supervisor history,
        // so a Transfer reads/writes it instead of duplicating supervisor
        // tracking a second time inside employee_transfers.
        const currentSupervisorRows = await queryDB(
          "SELECT supervisor_id FROM employee_supervisors WHERE employee_id = ? AND is_direct = 1 ORDER BY effective_date DESC, id DESC LIMIT 1",
          [id]
        );
        const fromSupervisorId = currentSupervisorRows.length > 0 ? currentSupervisorRows[0].supervisor_id : null;

        // 1. Record the history row first — `applied` matches whether step 2
        // below actually runs now, so the Transfer History list can show a
        // "Scheduled" row honestly instead of implying it already happened.
        const insertResult = await queryDB(
          `INSERT INTO employee_transfers
           (employee_id, from_department_id, from_department_name, to_department_id, to_department_name,
            from_designation, to_designation, from_supervisor_id, to_supervisor_id, effective_date, reason, action_by, applied)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            current.department_id ?? null,
            current.department ?? null,
            toDept.department_id,
            toDept.department_name,
            current.designation ?? null,
            toDesignation ?? null,
            fromSupervisorId,
            newSupervisorId,
            effectiveDateStr,
            reason && String(reason).trim() ? String(reason).trim() : null,
            req.user?.id ?? null,
            isDue ? 1 : 0
          ]
        );

        // 2 & 3. Only touch the live Employee row (and, if a new Supervisor
        // was picked, the Supervisor tab's own history) when the Effective
        // Date has actually arrived. A future-dated Transfer stops here —
        // its TO values stay parked in employee_transfers, un-applied, until
        // applyDueEmployeeTransfers promotes it on some later request, so the
        // employee's CURRENT position keeps showing correctly until then.
        if (isDue) {
          await applyTransferEffect(queryDB, {
            employee_id: id,
            to_department_id: toDept.department_id,
            to_department_name: toDept.department_name,
            to_designation: toDesignation,
            to_supervisor_id: newSupervisorId,
            effective_date: effectiveDateStr
          });
        }

        res.status(201).json({ success: true, id: insertResult.insertId, applied: isDue });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );
}