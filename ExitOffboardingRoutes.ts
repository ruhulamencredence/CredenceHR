/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Exit / Offboarding + Full & Final Settlement (Admin Panel -> HR Advanced ->
// "Exit / Offboarding") — kept in its own file, same reasoning as
// EmployeeTransferRoutes.ts/AssetManagementRoutes.ts: server.ts is already
// huge, so this registers from startServer() via registerExitOffboardingRoutes,
// reusing that request's authenticateToken/requireAdmin/requireModule/queryDB.
//
// Data model:
//   exit_requests — one row per resignation/termination, from first raised
//                   through clearance to Full & Final settlement.
//   exit_clearance_items — a per-department clearance checklist auto-seeded
//                   for every exit_requests row (IT/Finance/Admin/HR), each
//                   independently tickable.
//   final_settlements — one row per exit_requests row holding the actual
//                   Full & Final Settlement figures (unused leave encashment,
//                   gratuity, outstanding dues, net payable) and its own
//                   draft -> approved -> paid status.
//
// Every write route here only ever does `WHERE id = ?` in SQL — everything
// else (role scoping, "my own exit request only", joins to users/employees)
// is filtered/joined in JS after a full-table SELECT, same simplification
// GET /api/leave-balances above already relies on for all_employees. Fine at
// HR-admin-tool data volumes.

import type { Express } from "express";

const CLEARANCE_DEPARTMENTS: { department: string; item_label: string }[] = [
  { department: "IT", item_label: "Laptop / equipment & system access return" },
  { department: "Finance", item_label: "Loan / advance / expense clearance" },
  { department: "Admin", item_label: "ID card, asset & company property return" },
  { department: "HR", item_label: "Exit interview & final documents" },
];

interface ExitOffboardingRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: "exit_offboarding") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  getAdminModules: (userId: number) => Promise<string[]>;
}

export async function ensureExitOffboardingSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS exit_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        exit_type ENUM('resignation', 'termination') NOT NULL DEFAULT 'resignation',
        reason TEXT NULL,
        notice_date DATE NULL,
        last_working_day DATE NULL,
        status ENUM('pending', 'clearance', 'settled', 'cancelled') NOT NULL DEFAULT 'pending',
        requested_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure exit_requests table exists: " + err.message);
  }
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS exit_clearance_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        exit_id INT NOT NULL,
        department VARCHAR(100) NOT NULL,
        item_label VARCHAR(255) NOT NULL,
        is_cleared TINYINT(1) NOT NULL DEFAULT 0,
        cleared_by INT NULL,
        cleared_at TIMESTAMP NULL,
        remarks VARCHAR(500) NULL,
        -- Snapshotted from exit_clearance_approvers at the moment this exit
        -- request was created (see POST /api/exit-requests) — the same
        -- "snapshot, not live lookup" reasoning approval_requests.total_steps
        -- already uses elsewhere: changing who's assigned to a department
        -- later must never retroactively change who owns an
        -- already-in-flight clearance item.
        approver_user_id INT NULL,
        FOREIGN KEY (exit_id) REFERENCES exit_requests(id) ON DELETE CASCADE,
        FOREIGN KEY (cleared_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (approver_user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure exit_clearance_items table exists: " + err.message);
  }
  // Existing DBs from before approver_user_id existed — additive, so this is
  // a no-op everywhere else (fresh installs already get the column from the
  // CREATE TABLE above).
  try {
    await dbPool.query(`ALTER TABLE exit_clearance_items ADD COLUMN approver_user_id INT NULL`);
    await dbPool.query(`ALTER TABLE exit_clearance_items ADD FOREIGN KEY (approver_user_id) REFERENCES users(id) ON DELETE SET NULL`);
  } catch {
    // Column already exists — expected on every run after the first.
  }
  // Which login account is responsible for clearing each of the 4 fixed
  // clearance departments (Admin Panel -> Exit/Offboarding -> Clearance
  // Approvers) — deliberately its OWN small mapping, independent of the
  // Departments module's Supervisor (Admin Panel -> Departments): that
  // module's Department rows are free-form org-chart data an org may not
  // have named "IT"/"Finance"/"Admin"/"HR" at all, so this stays a simple,
  // always-applicable settings table instead of requiring an exact-name
  // match against Departments. NULL approver_user_id means "unassigned" —
  // that department's clearance items just never appear in anyone's
  // Approve Application queue until an Admin picks someone here (Admin can
  // still tick them by hand in ExitOffboardingPanel in the meantime).
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS exit_clearance_approvers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        department VARCHAR(100) NOT NULL UNIQUE,
        approver_user_id INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (approver_user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    for (const { department } of CLEARANCE_DEPARTMENTS) {
      await dbPool.query(`INSERT IGNORE INTO exit_clearance_approvers (department) VALUES (?)`, [department]);
    }
  } catch (err: any) {
    console.warn("⚠️ Could not ensure exit_clearance_approvers table exists: " + err.message);
  }
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS final_settlements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        exit_id INT NOT NULL,
        user_id INT NOT NULL,
        unused_leave_days DECIMAL(6, 1) NOT NULL DEFAULT 0,
        unused_leave_encashment DECIMAL(12, 2) NOT NULL DEFAULT 0,
        gratuity_amount DECIMAL(12, 2) NOT NULL DEFAULT 0,
        outstanding_dues DECIMAL(12, 2) NOT NULL DEFAULT 0,
        other_additions DECIMAL(12, 2) NOT NULL DEFAULT 0,
        other_deductions DECIMAL(12, 2) NOT NULL DEFAULT 0,
        net_payable DECIMAL(12, 2) NOT NULL DEFAULT 0,
        notes VARCHAR(500) NULL,
        status ENUM('draft', 'approved', 'paid') NOT NULL DEFAULT 'draft',
        prepared_by INT NULL,
        approved_by INT NULL,
        paid_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_settlement_exit (exit_id),
        FOREIGN KEY (exit_id) REFERENCES exit_requests(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (prepared_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure final_settlements table exists: " + err.message);
  }
}

export function registerExitOffboardingRoutes(app: Express, deps: ExitOffboardingRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB, getAdminModules } = deps;

  async function canManageExits(userId: number, role: string): Promise<boolean> {
    if (role === "superadmin") return true;
    if (role !== "admin" && role !== "user") return false;
    const modules = await getAdminModules(userId);
    return modules.includes("exit_offboarding");
  }

  async function serializeExit(exitRow: any): Promise<any> {
    const [users, items, settlements]: [any, any, any] = await Promise.all([
      queryDB("SELECT id, name, email, role FROM users"),
      queryDB("SELECT * FROM exit_clearance_items"),
      queryDB("SELECT * FROM final_settlements")
    ]);
    const userById = new Map(users.map((u: any) => [Number(u.id), u]));
    const u: any = userById.get(Number(exitRow.user_id));
    const requester: any = exitRow.requested_by ? userById.get(Number(exitRow.requested_by)) : null;
    return {
      id: Number(exitRow.id),
      user_id: Number(exitRow.user_id),
      user_name: u?.name || null,
      user_email: u?.email || null,
      exit_type: exitRow.exit_type,
      reason: exitRow.reason,
      notice_date: exitRow.notice_date,
      last_working_day: exitRow.last_working_day,
      status: exitRow.status,
      requested_by_name: requester?.name || null,
      created_at: exitRow.created_at,
      clearance_items: items
        .filter((it: any) => Number(it.exit_id) === Number(exitRow.id))
        .map((it: any) => ({
          id: Number(it.id),
          department: it.department,
          item_label: it.item_label,
          is_cleared: !!Number(it.is_cleared),
          remarks: it.remarks,
          approver_user_id: it.approver_user_id != null ? Number(it.approver_user_id) : null,
          approver_name: it.approver_user_id != null ? (userById.get(Number(it.approver_user_id)) as any)?.name || null : null
        })),
      settlement: (() => {
        const s = settlements.find((row: any) => Number(row.exit_id) === Number(exitRow.id));
        if (!s) return null;
        return {
          id: Number(s.id),
          unused_leave_days: Number(s.unused_leave_days),
          unused_leave_encashment: Number(s.unused_leave_encashment),
          gratuity_amount: Number(s.gratuity_amount),
          outstanding_dues: Number(s.outstanding_dues),
          other_additions: Number(s.other_additions),
          other_deductions: Number(s.other_deductions),
          net_payable: Number(s.net_payable),
          notes: s.notes,
          status: s.status,
          paid_at: s.paid_at
        };
      })()
    };
  }

  // GET: a Superadmin or exit_offboarding-granted account sees every exit
  // request; anyone else only ever sees their own.
  app.get("/api/exit-requests", authenticateToken, async (req: any, res) => {
    try {
      const canManage = await canManageExits(req.user.id, req.user.role);
      const rows: any = await queryDB("SELECT * FROM exit_requests");
      const scoped = canManage ? rows : rows.filter((r: any) => Number(r.user_id) === Number(req.user.id));
      const sorted = scoped.sort((a: any, b: any) => Number(b.id) - Number(a.id));
      res.json(await Promise.all(sorted.map(serializeExit)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST: any authenticated account may submit their OWN resignation
  // (user_id forced to req.user.id, exit_type forced to 'resignation');
  // initiating a termination for someone ELSE, or backdating a different
  // exit_type, requires the exit_offboarding module grant.
  app.post("/api/exit-requests", authenticateToken, async (req: any, res) => {
    try {
      const body = req.body || {};
      const canManage = await canManageExits(req.user.id, req.user.role);
      const targetUserId = canManage && body.user_id ? Number(body.user_id) : req.user.id;
      const exitType = canManage && body.exit_type === "termination" ? "termination" : "resignation";
      if (!canManage && targetUserId !== req.user.id) {
        return res.status(403).json({ error: "You can only submit your own resignation." });
      }
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 2000) : null;
      const noticeDate = body.notice_date ? String(body.notice_date).trim() : null;
      const lastWorkingDay = body.last_working_day ? String(body.last_working_day).trim() : null;

      const result: any = await queryDB(
        "INSERT INTO exit_requests (user_id, exit_type, reason, notice_date, last_working_day, status, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [targetUserId, exitType, reason, noticeDate, lastWorkingDay, "pending", req.user.id]
      );
      const exitId = Number(result.insertId);
      // Snapshot each department's currently-configured approver onto its
      // clearance item now (see the approver_user_id column comment) — a
      // department with no one assigned yet (approver_user_id stays NULL)
      // just never shows up in anyone's Approve Application queue; Admin can
      // still tick it by hand in ExitOffboardingPanel.
      const approverRows: any = await queryDB("SELECT * FROM exit_clearance_approvers");
      const approverByDept = new Map<string, number | null>(
        approverRows.map((r: any) => [r.department, r.approver_user_id != null ? Number(r.approver_user_id) : null])
      );
      for (const item of CLEARANCE_DEPARTMENTS) {
        await queryDB(
          "INSERT INTO exit_clearance_items (exit_id, department, item_label, approver_user_id) VALUES (?, ?, ?, ?)",
          [exitId, item.department, item.item_label, approverByDept.get(item.department) ?? null]
        );
      }
      const rows: any = await queryDB("SELECT * FROM exit_requests WHERE id = ?", [exitId]);
      res.status(201).json(await serializeExit(rows[0]));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT: change status (start clearance / cancel / mark settled) —
  // module-gated, an employee can never change their own exit's status.
  app.put("/api/exit-requests/:id/status", authenticateToken, requireAdmin, requireModule("exit_offboarding"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const status = req.body?.status;
      if (!["pending", "clearance", "settled", "cancelled"].includes(status)) {
        return res.status(400).json({ error: "Invalid status." });
      }
      await queryDB("UPDATE exit_requests SET status = ? WHERE id = ?", [status, id]);
      const rows: any = await queryDB("SELECT * FROM exit_requests WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Exit request not found." });
      res.json(await serializeExit(rows[0]));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT: tick/untick one clearance checklist item.
  app.put("/api/exit-clearance-items/:id", authenticateToken, requireAdmin, requireModule("exit_offboarding"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const isCleared = !!req.body?.is_cleared;
      const remarks = typeof req.body?.remarks === "string" ? req.body.remarks.trim().slice(0, 500) : null;
      await queryDB(
        "UPDATE exit_clearance_items SET is_cleared = ?, cleared_by = ?, cleared_at = ?, remarks = ? WHERE id = ?",
        [isCleared ? 1 : 0, isCleared ? req.user.id : null, isCleared ? new Date() : null, remarks, id]
      );
      const rows: any = await queryDB("SELECT * FROM exit_clearance_items WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Clearance item not found." });
      const r = rows[0];
      res.json({ id: Number(r.id), department: r.department, item_label: r.item_label, is_cleared: !!Number(r.is_cleared), remarks: r.remarks });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET: the 4 department -> approver assignments (Admin Panel -> Exit/
  // Offboarding -> Clearance Approvers settings) — module-gated, same as
  // every other management-side route here.
  app.get("/api/exit-clearance-approvers", authenticateToken, requireAdmin, requireModule("exit_offboarding"), async (req: any, res) => {
    try {
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM exit_clearance_approvers ORDER BY id ASC"),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map(users.map((u: any) => [Number(u.id), u]));
      res.json(
        rows.map((r: any) => ({
          department: r.department,
          approver_user_id: r.approver_user_id != null ? Number(r.approver_user_id) : null,
          approver_name: r.approver_user_id != null ? (userById.get(Number(r.approver_user_id)) as any)?.name || null : null
        }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT: (re)assign who's responsible for one department's clearance —
  // approver_user_id: null clears the assignment (that department's future
  // clearance items just won't route to anyone's Approve Application queue
  // until reassigned). Only affects clearance items created AFTER this
  // change — see the snapshot comment on exit_clearance_items.approver_user_id.
  app.put("/api/exit-clearance-approvers/:department", authenticateToken, requireAdmin, requireModule("exit_offboarding"), async (req: any, res) => {
    try {
      const department = req.params.department;
      const approverUserId = req.body?.approver_user_id != null ? Number(req.body.approver_user_id) : null;
      // Filtered/updated-by-id in JS rather than `WHERE department = ?` —
      // this file's own top comment already establishes that every write
      // route here only ever does `WHERE id = ?` in SQL, everything else
      // filtered in JS after a full-table SELECT.
      const all: any = await queryDB("SELECT * FROM exit_clearance_approvers");
      const existing = all.find((r: any) => r.department === department);
      if (!existing) return res.status(404).json({ error: "Unknown clearance department." });
      await queryDB("UPDATE exit_clearance_approvers SET approver_user_id = ? WHERE id = ?", [approverUserId, Number(existing.id)]);
      const users: any = approverUserId != null ? await queryDB("SELECT id, name FROM users WHERE id = ?", [approverUserId]) : [];
      res.json({ department, approver_user_id: approverUserId, approver_name: users[0]?.name || null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST: the department approver's own Approve/Reject decision on their
  // clearance item — reached from the Approve Application inbox
  // (source_type 'exit_clearance', see GET /api/my-approvals), NOT
  // module-gated like the PUT above: this is deliberately reachable by
  // whichever plain account is currently assigned as a department's
  // approver, same "any account can be an approver" philosophy the
  // Department Supervisor / Approval Template steps already use elsewhere.
  // 'rejected' just leaves the item unticked with the approver's remarks
  // attached (there's no real "permanently reject a clearance" concept —
  // it only ever means "not cleared yet", the department can act again
  // later once whatever's blocking it is resolved).
  app.post("/api/exit-clearance-items/:id/decision", authenticateToken, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const action = req.body?.action;
      if (action !== "approved" && action !== "rejected") {
        return res.status(400).json({ error: "action must be 'approved' or 'rejected'." });
      }
      const remarks = typeof req.body?.remarks === "string" ? req.body.remarks.trim().slice(0, 500) : null;
      const rows: any = await queryDB("SELECT * FROM exit_clearance_items WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Clearance item not found." });
      const item = rows[0];
      if (item.approver_user_id == null || Number(item.approver_user_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: "This clearance item isn't assigned to you." });
      }
      const isCleared = action === "approved";
      await queryDB(
        "UPDATE exit_clearance_items SET is_cleared = ?, cleared_by = ?, cleared_at = ?, remarks = ? WHERE id = ?",
        [isCleared ? 1 : 0, isCleared ? req.user.id : null, isCleared ? new Date() : null, remarks, id]
      );
      const updated: any = await queryDB("SELECT * FROM exit_clearance_items WHERE id = ?", [id]);
      const r = updated[0];
      res.json({ id: Number(r.id), department: r.department, item_label: r.item_label, is_cleared: !!Number(r.is_cleared), remarks: r.remarks });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET: fetch (auto-creating a draft on first visit) this exit's Full &
  // Final Settlement — unused_leave_days is pre-filled from the account's
  // current Casual+Sick balance (leave_balances) as a starting suggestion;
  // every other figure is left for the preparer to fill in by hand
  // (gratuity/outstanding dues aren't auto-computed — no gratuity formula or
  // loan ledger wired up yet).
  app.get("/api/exit-requests/:id/settlement", authenticateToken, requireAdmin, requireModule("exit_offboarding"), async (req: any, res) => {
    try {
      const exitId = Number(req.params.id);
      const exitRows: any = await queryDB("SELECT * FROM exit_requests WHERE id = ?", [exitId]);
      if (exitRows.length === 0) return res.status(404).json({ error: "Exit request not found." });
      const exitRow = exitRows[0];

      let settlementRows: any = await queryDB("SELECT * FROM final_settlements");
      let settlement = settlementRows.find((s: any) => Number(s.exit_id) === exitId);
      if (!settlement) {
        const balRows: any = await queryDB("SELECT * FROM leave_balances WHERE user_id = ?", [exitRow.user_id]);
        const bal = balRows[0];
        const suggestedLeaveDays = bal ? Number(bal.casual_leave || 0) + Number(bal.sick_leave || 0) : 0;
        const result: any = await queryDB(
          `INSERT INTO final_settlements
           (exit_id, user_id, unused_leave_days, unused_leave_encashment, gratuity_amount, outstanding_dues, other_additions, other_deductions, net_payable, status, prepared_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [exitId, exitRow.user_id, suggestedLeaveDays, 0, 0, 0, 0, 0, 0, "draft", req.user.id]
        );
        const freshRows: any = await queryDB("SELECT * FROM final_settlements WHERE id = ?", [Number(result.insertId)]);
        settlement = freshRows[0];
      }
      res.json({
        id: Number(settlement.id),
        unused_leave_days: Number(settlement.unused_leave_days),
        unused_leave_encashment: Number(settlement.unused_leave_encashment),
        gratuity_amount: Number(settlement.gratuity_amount),
        outstanding_dues: Number(settlement.outstanding_dues),
        other_additions: Number(settlement.other_additions),
        other_deductions: Number(settlement.other_deductions),
        net_payable: Number(settlement.net_payable),
        notes: settlement.notes,
        status: settlement.status
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT: update the settlement figures — net_payable is always
  // server-recomputed (additions - deductions), never trusted from the
  // client, so it can't drift from the line items shown.
  app.put("/api/exit-requests/:id/settlement", authenticateToken, requireAdmin, requireModule("exit_offboarding"), async (req: any, res) => {
    try {
      const exitId = Number(req.params.id);
      const body = req.body || {};
      const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      const unusedLeaveDays = num(body.unused_leave_days);
      const unusedLeaveEncashment = num(body.unused_leave_encashment);
      const gratuityAmount = num(body.gratuity_amount);
      const outstandingDues = num(body.outstanding_dues);
      const otherAdditions = num(body.other_additions);
      const otherDeductions = num(body.other_deductions);
      const netPayable = unusedLeaveEncashment + gratuityAmount + otherAdditions - outstandingDues - otherDeductions;
      const status = ["draft", "approved", "paid"].includes(body.status) ? body.status : "draft";
      const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : null;

      const settlementRows: any = await queryDB("SELECT * FROM final_settlements");
      const settlement = settlementRows.find((s: any) => Number(s.exit_id) === exitId);
      if (!settlement) return res.status(404).json({ error: "Settlement not found — open it first to create the draft." });

      await queryDB(
        `UPDATE final_settlements SET unused_leave_days = ?, unused_leave_encashment = ?, gratuity_amount = ?,
         outstanding_dues = ?, other_additions = ?, other_deductions = ?, net_payable = ?, notes = ?, status = ?,
         approved_by = ?, paid_at = ? WHERE id = ?`,
        [
          unusedLeaveDays,
          unusedLeaveEncashment,
          gratuityAmount,
          outstandingDues,
          otherAdditions,
          otherDeductions,
          netPayable,
          notes,
          status,
          status === "approved" || status === "paid" ? req.user.id : settlement.approved_by,
          status === "paid" ? new Date() : settlement.paid_at,
          Number(settlement.id)
        ]
      );
      if (status === "paid") {
        await queryDB("UPDATE exit_requests SET status = ? WHERE id = ?", ["settled", exitId]);
      }
      const rows: any = await queryDB("SELECT * FROM final_settlements WHERE id = ?", [Number(settlement.id)]);
      const s = rows[0];
      res.json({
        id: Number(s.id),
        unused_leave_days: Number(s.unused_leave_days),
        unused_leave_encashment: Number(s.unused_leave_encashment),
        gratuity_amount: Number(s.gratuity_amount),
        outstanding_dues: Number(s.outstanding_dues),
        other_additions: Number(s.other_additions),
        other_deductions: Number(s.other_deductions),
        net_payable: Number(s.net_payable),
        notes: s.notes,
        status: s.status
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
