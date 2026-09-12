/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Leave Management — Leave Balances (self-service "mine" + Leave Manager's
// full/bulk view+edit), and Leave Applications (approvers/relievers lookup,
// mine, submit, reliever decision, Admin/Leave-Manager list, and decision).
// Split out of server.ts on purpose — server.ts is already ~8,300 lines in
// one file, so this moves out as-is (no logic changes) the same way Personal
// Data, Users, Holidays, Conveyance Bill Claims, Attendance, and Approvals
// already were. Registered from inside startServer() via
// registerLeaveRoutes(), reusing that same request's
// `app`/`authenticateToken`/`queryDB`/etc. rather than creating a second
// Express app or a second DB connection.
//
// Dependencies below are all defined elsewhere in server.ts and shared with
// other modules (e.g. getCurrentStepApprovers also backs the Approval
// Workflow/Conveyance Bill Claims, createAlert is the general notification
// helper from Alerts.ts), so they're threaded through as deps rather than
// duplicated or re-imported directly.

import type { Express } from "express";

interface LeaveRouteDeps {
  authenticateToken: any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  requireLeaveManager: (req: any, res: any, next: any) => Promise<any>;
  hasLeaveManageAccess: (userId: number, role: string) => Promise<boolean>;
  getCurrentStepApprovers: (request: any) => Promise<{ user_id: number; user_name: string | null }[]>;
  createAlert: (...args: any[]) => Promise<any>;
  approveLeaveApplicationReliever: (leaveId: number, relieverUserId: number, remarks: string | null) => Promise<any>;
  rejectLeaveApplicationReliever: (leaveId: number, relieverUserId: number, remarks: string | null) => Promise<any>;
}

export function registerLeaveRoutes(app: Express, deps: LeaveRouteDeps) {
  const {
    authenticateToken,
    queryDB,
    requireLeaveManager,
    hasLeaveManageAccess,
    getCurrentStepApprovers,
    createAlert,
    approveLeaveApplicationReliever,
    rejectLeaveApplicationReliever
  } = deps;

  // Sum of day_count already deducted from an account's balance for leave
  // taken THIS calendar year (status != 'rejected' — a rejected application's
  // day_count was already given back at decision time, so it never actually
  // reduced the balance). Scoped by the leave's start_date, since that's what
  // "this year's usage" means for annual leave accounting, not when it was
  // applied for.
  //
  // Used by both "Set Balance in Bulk" and the single-account PUT below, so
  // setting a new balance never blindly overwrites what an account has
  // already spent this year — the new balance becomes (new total - already
  // used), floored at 0. This also doubles as the year-end reset: once the
  // calendar year turns over, no leave has been taken against it yet, so
  // "already used" is naturally 0 and re-running Set Balance in Bulk gives
  // everyone a clean fresh balance with no separate year-end job needed.
  async function getUsedThisYear(userId: number): Promise<{ casual: number; sick: number; without_pay: number }> {
    const year = new Date().getFullYear();
    const rows: any = await queryDB(
      "SELECT leave_type, day_count FROM leave_applications WHERE user_id = ? AND status != 'rejected' AND YEAR(start_date) = ?",
      [userId, year]
    );
    const used = { casual: 0, sick: 0, without_pay: 0 };
    for (const r of rows) {
      const dc = Number(r.day_count) || 0;
      if (r.leave_type === "casual") used.casual += dc;
      else if (r.leave_type === "sick") used.sick += dc;
      else if (r.leave_type === "without_pay") used.without_pay += dc;
    }
    return used;
  }

  // Self Service -> Leave Application / Leave Summary card (own balance only).
  // Always returns the requesting account's own single row, even if that
  // account also holds can_manage_leave (Leave Manager) access — unlike
  // GET /api/leave-balances below, this never switches to the "every
  // Admin/User's balances" shape, so self-service screens can't accidentally
  // pick up a *different* account's balance via rows[0]. A missing
  // leave_balances row just reads as 0/0/0.
  app.get("/api/leave-balances/mine", authenticateToken, async (req: any, res) => {
    try {
      const rows: any = await queryDB("SELECT * FROM leave_balances WHERE user_id = ?", [req.user.id]);
      const b = rows[0];
      res.json([{
        user_id: req.user.id,
        user_name: req.user.name,
        user_role: req.user.role,
        casual_leave: b ? Number(b.casual_leave) : 0,
        sick_leave: b ? Number(b.sick_leave) : 0,
        leave_without_pay: b ? Number(b.leave_without_pay) : 0,
        updated_at: b ? b.updated_at : null
      }]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Self Service -> Leave Management (Leave Balances)
  // GET: a Superadmin or any can_manage_leave-granted account gets EVERY
  // Admin/User's balances (for editing); everyone else gets back only their own
  // single row (read-only view alongside the Leave Application page). A missing
  // leave_balances row just reads as 0/0/0 rather than needing one seeded at
  // account-creation time.
  app.get("/api/leave-balances", authenticateToken, async (req: any, res) => {
    try {
      const canManageAll = await hasLeaveManageAccess(req.user.id, req.user.role);

      if (canManageAll) {
        const users: any = await queryDB("SELECT id, name, role FROM users WHERE role IN ('admin', 'user')");
        const balances: any = await queryDB("SELECT * FROM leave_balances");
        // Department comes from the Employee Directory row linked to this login
        // account (all_employees.user_id) — no department column of its own on
        // users/leave_balances, so "Set Balance in Bulk" below can group/filter
        // by it without a schema change.
        const employees: any = await queryDB("SELECT * FROM all_employees");
        const byUser = new Map<number, any>();
        for (const b of balances) byUser.set(Number(b.user_id), b);
        const departmentByUserId = new Map<number, string>();
        for (const e of employees) {
          if (e.user_id != null && e.department) departmentByUserId.set(Number(e.user_id), e.department);
        }

        res.json(users.map((u: any) => {
          const b = byUser.get(u.id);
          return {
            user_id: u.id,
            user_name: u.name,
            user_role: u.role,
            department: departmentByUserId.get(u.id) || null,
            casual_leave: b ? Number(b.casual_leave) : 0,
            sick_leave: b ? Number(b.sick_leave) : 0,
            leave_without_pay: b ? Number(b.leave_without_pay) : 0,
            updated_at: b ? b.updated_at : null
          };
        }));
      } else {
        const rows: any = await queryDB("SELECT * FROM leave_balances WHERE user_id = ?", [req.user.id]);
        const b = rows[0];
        res.json([{
          user_id: req.user.id,
          user_name: req.user.name,
          user_role: req.user.role,
          casual_leave: b ? Number(b.casual_leave) : 0,
          sick_leave: b ? Number(b.sick_leave) : 0,
          leave_without_pay: b ? Number(b.leave_without_pay) : 0,
          updated_at: b ? b.updated_at : null
        }]);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT: "Set Balance in Bulk" — apply the same Casual/Sick/Leave-without-Pay
  // balance to many accounts in one go instead of editing rows one at a time.
  // req.body.departments: [] or omitted = every Admin/User account (Global);
  // otherwise every account linked (via all_employees.user_id) to one of the
  // given Department names. Same requireLeaveManager gate as the single-account
  // PUT below, and the same per-account upsert it uses — just looped.
  // NOTE: registered BEFORE PUT /api/leave-balances/:userId on purpose — Express
  // matches routes in registration order and :userId would otherwise swallow
  // this exact path (matching "bulk" as if it were a userId) and 404 first.
  app.put("/api/leave-balances/bulk", authenticateToken, requireLeaveManager, async (req: any, res) => {
    try {
      const casual = Number(req.body?.casual_leave);
      const sick = Number(req.body?.sick_leave);
      const lwp = Number(req.body?.leave_without_pay);
      if ([casual, sick, lwp].some((n) => !Number.isFinite(n) || n < 0)) {
        return res.status(400).json({ error: "Leave balances must be non-negative numbers." });
      }

      const departments: string[] = Array.isArray(req.body?.departments)
        ? req.body.departments.map((d: any) => String(d).trim()).filter(Boolean)
        : [];

      const users: any = await queryDB("SELECT id, name, role FROM users WHERE role IN ('admin', 'user')");

      let targetIds: number[];
      if (departments.length === 0) {
        // No department filter -> Global, every Admin/User account.
        targetIds = users.map((u: any) => Number(u.id));
      } else {
        const employees: any = await queryDB("SELECT * FROM all_employees");
        const departmentByUserId = new Map<number, string>();
        for (const e of employees) {
          if (e.user_id != null && e.department) departmentByUserId.set(Number(e.user_id), e.department);
        }
        const deptSet = new Set(departments);
        targetIds = users
          .map((u: any) => Number(u.id))
          .filter((id: number) => {
            const dept = departmentByUserId.get(id);
            return dept ? deptSet.has(dept) : false;
          });
      }

      if (targetIds.length === 0) {
        return res.status(400).json({ error: "No matching accounts found for that selection." });
      }

      for (const userId of targetIds) {
        // Already-spent-this-year comes off the new total per account, so
        // someone who already took leave this year doesn't get handed the
        // full fresh quota on top of what they've used.
        const used = await getUsedThisYear(userId);
        const adjCasual = Math.max(0, casual - used.casual);
        const adjSick = Math.max(0, sick - used.sick);
        const adjLwp = Math.max(0, lwp - used.without_pay);

        const existing: any = await queryDB("SELECT id FROM leave_balances WHERE user_id = ?", [userId]);
        if (existing.length > 0) {
          await queryDB(
            "UPDATE leave_balances SET casual_leave = ?, sick_leave = ?, leave_without_pay = ? WHERE user_id = ?",
            [adjCasual, adjSick, adjLwp, userId]
          );
        } else {
          await queryDB(
            "INSERT INTO leave_balances (user_id, casual_leave, sick_leave, leave_without_pay) VALUES (?, ?, ?, ?)",
            [userId, adjCasual, adjSick, adjLwp]
          );
        }
      }

      res.json({
        success: true,
        updated_count: targetIds.length,
        // Note: these are the entered annual totals, not necessarily each
        // account's resulting balance — accounts with leave already taken
        // this year were adjusted down individually above. The Leave
        // Manage table is re-fetched right after this call, so it always
        // shows each account's real adjusted balance.
        casual_leave: casual,
        sick_leave: sick,
        leave_without_pay: lwp
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT: set one account's Casual/Sick/Leave-without-Pay balance. Superadmin or
  // can_manage_leave-granted only (requireLeaveManager) — a plain account can
  // never edit even its own row here.
  app.put("/api/leave-balances/:userId", authenticateToken, requireLeaveManager, async (req: any, res) => {
    try {
      const { userId } = req.params;
      const casual = Number(req.body?.casual_leave);
      const sick = Number(req.body?.sick_leave);
      const lwp = Number(req.body?.leave_without_pay);
      if ([casual, sick, lwp].some((n) => !Number.isFinite(n) || n < 0)) {
        return res.status(400).json({ error: "Leave balances must be non-negative numbers." });
      }

      const target: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [userId]);
      if (target.length === 0) return res.status(404).json({ error: "User not found" });
      if (target[0].role === "superadmin") {
        return res.status(400).json({ error: "Leave balances don't apply to the Superadmin account." });
      }

      // Same already-spent-this-year adjustment as "Set Balance in Bulk"
      // above — see getUsedThisYear for why.
      const used = await getUsedThisYear(Number(userId));
      const adjCasual = Math.max(0, casual - used.casual);
      const adjSick = Math.max(0, sick - used.sick);
      const adjLwp = Math.max(0, lwp - used.without_pay);

      const existing: any = await queryDB("SELECT id FROM leave_balances WHERE user_id = ?", [userId]);
      if (existing.length > 0) {
        await queryDB(
          "UPDATE leave_balances SET casual_leave = ?, sick_leave = ?, leave_without_pay = ? WHERE user_id = ?",
          [adjCasual, adjSick, adjLwp, userId]
        );
      } else {
        await queryDB(
          "INSERT INTO leave_balances (user_id, casual_leave, sick_leave, leave_without_pay) VALUES (?, ?, ?, ?)",
          [userId, adjCasual, adjSick, adjLwp]
        );
      }

      res.json({ success: true, user_id: Number(userId), casual_leave: adjCasual, sick_leave: adjSick, leave_without_pay: adjLwp });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Self Service -> Leave Application
  // GET: every Admin/Superadmin account, for the New Leave Application modal's
  // Approver picker. Any authenticated account can call this (unlike
  // GET /api/users, which is Admin-only) since a plain User still needs to pick
  // someone to route their application to.
  app.get("/api/leave-applications/approvers", authenticateToken, async (req: any, res) => {
    try {
      const approvers = await queryDB("SELECT id, name FROM users WHERE role IN ('admin','superadmin') ORDER BY name ASC");
      res.json(approvers);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Reliever picker (NewLeaveApplicationModal) — unlike the old Approver
  // picker above, a Reliever can be ANY account (role='user' included, same
  // "role permissiveness" as a Template step's approvers), just never the
  // applicant themselves.
  app.get("/api/leave-applications/relievers", authenticateToken, async (req: any, res) => {
    try {
      const relievers = await queryDB("SELECT id, name FROM users WHERE id != ? ORDER BY name ASC", [req.user.id]);
      res.json(relievers);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET: the current account's own submitted Leave Applications, newest first,
  // with the Approver's name attached — see LeaveApplication.tsx. For legacy
  // rows (approver_id set, pre-Part-5) that's the applicant's own pick, same
  // as always; for new Template-driven rows (approver_id NULL) it's instead
  // whoever the Dynamic Approval Engine currently has it waiting on (Part 3's
  // getCurrentStepApprovers), so the applicant can still see who to nudge.
  app.get("/api/leave-applications/mine", authenticateToken, async (req: any, res) => {
    try {
      const rows = await queryDB(
        `SELECT la.*, u.name AS approver_name, rv.name AS reliever_name
         FROM leave_applications la
         LEFT JOIN users u ON u.id = la.approver_id
         LEFT JOIN users rv ON rv.id = la.reliever_id
         WHERE la.user_id = ? ORDER BY la.created_at DESC`,
        [req.user.id]
      );
      let approvalByLeaveId = new Map<number, any>();
      if (rows.length > 0) {
        // requested_by, not an IN (source_id...) list — queryDB uses
        // dbPool.execute() (prepared statements), which does NOT expand an
        // array into an IN (?) list the way dbPool.query() would.
        const approvalRequests = await queryDB(
          "SELECT * FROM approval_requests WHERE source_type = 'leave_application' AND requested_by = ?",
          [req.user.id]
        );
        approvalByLeaveId = new Map(approvalRequests.map((ar: any) => [Number(ar.source_id), ar]));
      }
      const enriched = await Promise.all(
        rows.map(async (r: any) => {
          const ar = approvalByLeaveId.get(Number(r.id));
          let currentApproverName = r.approver_name;
          let currentStep: number | null = null;
          let totalSteps: number | null = null;
          if (ar) {
            totalSteps = Number(ar.total_steps);
            currentStep = Number(ar.current_step);
            if (ar.status === "pending") {
              const approvers = await getCurrentStepApprovers(ar);
              currentApproverName = approvers.length > 0 ? approvers.map((a) => a.user_name || `User #${a.user_id}`).join(" or ") : null;
            }
          }
          return {
            ...r,
            day_count: Number(r.day_count),
            is_continuous: !!Number(r.is_continuous),
            is_prefix: !!Number(r.is_prefix),
            is_suffix: !!Number(r.is_suffix),
            is_half_day: !!Number(r.is_half_day),
            include_extra_work_dates: !!Number(r.include_extra_work_dates),
            is_foreign_leave: !!Number(r.is_foreign_leave),
            approver_name: currentApproverName,
            current_step: currentStep,
            total_steps: totalSteps,
            reliever_name: r.reliever_name || null
          };
        })
      );
      res.json(enriched);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST: submit a new Leave Application. Recomputes day_count server-side from
  // start_date/end_date/is_half_day (never trusts the client's number), then
  // immediately deducts it from the account's leave_balances row for the
  // matching column — casual/sick/without_pay -> casual_leave/sick_leave/
  // leave_without_pay — refusing the whole request if that would go negative.
  // Dynamic Approval Engine (Part 5) — the applicant no longer picks their own
  // Approver here (that field is gone from the request body entirely); this is
  // instead routed through the submitting Employee's assigned Template for
  // request_type 'leave' (Part 3's createTemplateApprovalRequest), falling
  // back to that request_type's default, and to a straight auto-approve if
  // neither exists. Old, already-pending applications from before this change
  // (which DO have an approver_id) are untouched and keep working exactly as
  // before via POST /api/leave-applications/:id/decision below.
  app.post("/api/leave-applications", authenticateToken, async (req: any, res) => {
    try {
      const {
        leave_type, start_date, end_date, is_continuous, is_prefix, is_suffix,
        is_half_day, include_extra_work_dates, is_foreign_leave, purpose, reliever_id
      } = req.body || {};

      if (!["casual", "sick", "without_pay"].includes(leave_type)) {
        return res.status(400).json({ error: "Select a valid Leave Type." });
      }
      if (!start_date || !end_date || String(end_date) < String(start_date)) {
        return res.status(400).json({ error: "Start Date and End Date are required, and End Date can't be before Start Date." });
      }
      const trimmedPurpose = typeof purpose === "string" ? purpose.trim() : "";
      if (!trimmedPurpose) return res.status(400).json({ error: "Purpose is required." });

      const relieverUserId = Number(reliever_id);
      if (!relieverUserId || !Number.isFinite(relieverUserId)) {
        return res.status(400).json({ error: "Select a Reliever." });
      }
      if (relieverUserId === Number(req.user.id)) {
        return res.status(400).json({ error: "You can't select yourself as Reliever." });
      }
      const relieverRows: any = await queryDB("SELECT id, name FROM users WHERE id = ?", [relieverUserId]);
      if (relieverRows.length === 0) {
        return res.status(400).json({ error: "Selected Reliever not found." });
      }

      // Calendar days between start/end, inclusive of both ends — Half Day trims
      // 0.5 off the total (floored at 0.5). Mirrors calcDayCount in
      // NewLeaveApplicationModal.tsx exactly, computed here too so a tampered
      // client-side value can never change what gets deducted.
      const s = new Date(`${start_date}T00:00:00`);
      const e = new Date(`${end_date}T00:00:00`);
      const diffDays = Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      const dayCount = diffDays <= 0 ? 0 : (is_half_day ? Math.max(0.5, diffDays - 0.5) : diffDays);
      if (dayCount <= 0) return res.status(400).json({ error: "Day Count must be greater than 0." });

      const balanceColumn = leave_type === "casual" ? "casual_leave" : leave_type === "sick" ? "sick_leave" : "leave_without_pay";
      const balanceRows: any = await queryDB("SELECT * FROM leave_balances WHERE user_id = ?", [req.user.id]);
      const currentBalance = balanceRows.length > 0 ? Number(balanceRows[0][balanceColumn]) : 0;
      if (dayCount > currentBalance) {
        return res.status(400).json({ error: `Day Count (${dayCount}) exceeds your remaining balance (${currentBalance}) for this Leave Type.` });
      }

      const newCasual = balanceColumn === "casual_leave" ? currentBalance - dayCount : Number(balanceRows[0]?.casual_leave || 0);
      const newSick = balanceColumn === "sick_leave" ? currentBalance - dayCount : Number(balanceRows[0]?.sick_leave || 0);
      const newLwp = balanceColumn === "leave_without_pay" ? currentBalance - dayCount : Number(balanceRows[0]?.leave_without_pay || 0);
      await queryDB(
        "UPDATE leave_balances SET casual_leave = ?, sick_leave = ?, leave_without_pay = ? WHERE user_id = ?",
        [newCasual, newSick, newLwp, req.user.id]
      );

      const result: any = await queryDB(
        `INSERT INTO leave_applications
          (user_id, leave_type, start_date, end_date, day_count, is_continuous, is_prefix, is_suffix, is_half_day, include_extra_work_dates, is_foreign_leave, purpose, approver_id, status, apply_date, reliever_id, reliever_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', CURDATE(), ?, 'pending')`,
        [
          req.user.id, leave_type, start_date, end_date, dayCount,
          !!is_continuous, !!is_prefix, !!is_suffix, !!is_half_day, !!include_extra_work_dates, !!is_foreign_leave,
          trimmedPurpose, relieverUserId
        ]
      );

      // Reliever workflow — the request sits waiting on the picked Reliever
      // first; the Dynamic Approval Engine (createTemplateApprovalRequest)
      // only gets invoked once that Reliever Approves — see
      // approveLeaveApplicationReliever / POST
      // /api/leave-applications/:id/reliever-decision below. Nothing to
      // auto-approve here at submission time anymore.
      await createAlert(queryDB, {
        userId: relieverUserId,
        type: "leave_application",
        title: "You've Been Selected as Reliever",
        message: `${req.user.name} selected you as Reliever for their Leave Application (${start_date} to ${end_date}). Please review it.`,
        relatedType: "leave_application",
        relatedId: result.insertId
      });

      res.json({ success: true, id: result.insertId, day_count: dayCount });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST: the picked Reliever Approves or Rejects — must happen BEFORE the
  // request can move into the Dynamic Approval Engine at all (see the design
  // note above POST /api/leave-applications). Only the reliever_id on this
  // specific application, or a Superadmin (override, same pattern as every
  // other decision route here), may act — and only once, while
  // reliever_status is still 'pending'.
  app.post("/api/leave-applications/:id/reliever-decision", authenticateToken, async (req: any, res) => {
    try {
      const { action, remarks } = req.body || {};
      if (action !== "approved" && action !== "rejected") {
        return res.status(400).json({ error: "action must be 'approved' or 'rejected'." });
      }
      const trimmedRemarks = typeof remarks === "string" ? remarks.trim().slice(0, 1000) || null : null;
      if (action === "rejected" && !trimmedRemarks) {
        return res.status(400).json({ error: "Please give a reason so the applicant understands why." });
      }

      const rows: any = await queryDB("SELECT * FROM leave_applications WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Leave Application not found" });
      const application = rows[0];
      if (application.reliever_id === null) {
        return res.status(400).json({ error: "This Leave Application has no Reliever assigned." });
      }
      if (req.user.role !== "superadmin" && Number(application.reliever_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: "Only the Reliever picked on this Leave Application can act on it." });
      }
      if (application.reliever_status !== "pending") {
        return res.status(400).json({ error: "You've already reviewed this Leave Application." });
      }
      if (application.status !== "pending") {
        return res.status(400).json({ error: "This Leave Application has already been reviewed." });
      }

      if (action === "approved") {
        await approveLeaveApplicationReliever(Number(req.params.id), req.user.id, trimmedRemarks);
      } else {
        await rejectLeaveApplicationReliever(Number(req.params.id), req.user.id, trimmedRemarks);
      }

      res.json({ success: true, reliever_status: action });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET: every Leave Application any Admin/Superadmin needs to review — a
  // Superadmin sees all of them, a plain Admin only sees the ones where THEY
  // were picked as the Approver. Self Service -> Leave Approvals.
  app.get("/api/leave-applications", authenticateToken, async (req: any, res) => {
    try {
      if (req.user.role !== "admin" && req.user.role !== "superadmin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      const [applications, users, approvalRequests] = await Promise.all([
        queryDB("SELECT * FROM leave_applications ORDER BY created_at DESC"),
        queryDB("SELECT id, name, role FROM users"),
        // Dynamic Approval Engine (Part 5) — same enrichment
        // GET /api/leave-applications/mine does for the applicant's own view,
        // so this Admin-facing list can also show who a Template-routed
        // application (approver_id NULL) is currently waiting on, instead of
        // a blank Approver column.
        queryDB("SELECT * FROM approval_requests WHERE source_type = 'leave_application'")
      ]);
      const userMap = new Map<number, any>(users.map((u: any) => [Number(u.id), u]));
      const approvalByLeaveId = new Map<number, any>(approvalRequests.map((ar: any) => [Number(ar.source_id), ar]));
      const visible = req.user.role === "superadmin"
        ? applications
        : applications.filter((a: any) => Number(a.approver_id) === Number(req.user.id));

      const enriched = await Promise.all(
        visible.map(async (a: any) => {
          const ar = approvalByLeaveId.get(Number(a.id));
          let approverName = userMap.get(Number(a.approver_id))?.name || null;
          let currentStep: number | null = null;
          let totalSteps: number | null = null;
          if (ar) {
            totalSteps = Number(ar.total_steps);
            currentStep = Number(ar.current_step);
            if (ar.status === "pending") {
              const approvers = await getCurrentStepApprovers(ar);
              approverName = approvers.length > 0 ? approvers.map((x: any) => x.user_name || `User #${x.user_id}`).join(" or ") : null;
            }
          }
          return {
            ...a,
            day_count: Number(a.day_count),
            is_continuous: !!Number(a.is_continuous),
            is_prefix: !!Number(a.is_prefix),
            is_suffix: !!Number(a.is_suffix),
            is_half_day: !!Number(a.is_half_day),
            include_extra_work_dates: !!Number(a.include_extra_work_dates),
            is_foreign_leave: !!Number(a.is_foreign_leave),
            user_name: userMap.get(Number(a.user_id))?.name || "(account removed)",
            approver_name: approverName,
            decided_by_name: a.decided_by ? (userMap.get(Number(a.decided_by))?.name || null) : null,
            current_step: currentStep,
            total_steps: totalSteps,
            reliever_name: a.reliever_id ? (userMap.get(Number(a.reliever_id))?.name || null) : null,
            reliever_status: a.reliever_status || null
          };
        })
      );
      res.json(enriched);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST: Approve or Reject a pending Leave Application submitted the OLD way
  // (applicant picked their own Approver — approver_id is set). Kept working
  // exactly as before, UNCHANGED, purely so any application already 'pending'
  // from before Part 5 shipped doesn't get stranded (Part 5's own migration
  // promise: never break an in-flight request). Only the Approver the account
  // picked when applying, or any Superadmin (override), may act — and only
  // while it's still 'pending'. Approve just flips the status (day_count was
  // already deducted at submission time, so nothing else to do). Reject gives
  // the day_count back to the account's leave_balances row for that Leave
  // Type, since it was never actually taken.
  //
  // NEW applications (submitted after Part 5) have approver_id NULL and are
  // routed through the Dynamic Approval Engine instead — decide those via
  // POST /api/approvals/:id/act (Admin Panel queue) or POST
  // /api/my-approvals/:id/act (personal queue), not this route.
  app.post("/api/leave-applications/:id/decision", authenticateToken, async (req: any, res) => {
    try {
      if (req.user.role !== "admin" && req.user.role !== "superadmin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      const { action, remarks } = req.body || {};
      if (action !== "approve" && action !== "reject") {
        return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
      }
      const trimmedRemarks = typeof remarks === "string" ? remarks.trim().slice(0, 1000) : null;
      if (action === "reject" && !trimmedRemarks) {
        return res.status(400).json({ error: "Please give a reason so the account understands why." });
      }

      const rows: any = await queryDB("SELECT * FROM leave_applications WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Leave Application not found" });
      const application = rows[0];
      if (application.status !== "pending") {
        return res.status(400).json({ error: "This Leave Application has already been reviewed." });
      }
      if (application.approver_id === null) {
        return res.status(400).json({
          error: "This Leave Application is routed through the Approval Workflow \u2014 use the Approvals queue (or your Pending Approvals on the Dashboard) instead."
        });
      }
      if (req.user.role !== "superadmin" && Number(application.approver_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: "Only the Approver picked on this Leave Application can act on it." });
      }

      if (action === "reject") {
        const balanceColumn = application.leave_type === "casual" ? "casual_leave" : application.leave_type === "sick" ? "sick_leave" : "leave_without_pay";
        const balanceRows: any = await queryDB("SELECT * FROM leave_balances WHERE user_id = ?", [application.user_id]);
        const casual = Number(balanceRows[0]?.casual_leave || 0) + (balanceColumn === "casual_leave" ? Number(application.day_count) : 0);
        const sick = Number(balanceRows[0]?.sick_leave || 0) + (balanceColumn === "sick_leave" ? Number(application.day_count) : 0);
        const lwp = Number(balanceRows[0]?.leave_without_pay || 0) + (balanceColumn === "leave_without_pay" ? Number(application.day_count) : 0);
        if (balanceRows.length > 0) {
          await queryDB(
            "UPDATE leave_balances SET casual_leave = ?, sick_leave = ?, leave_without_pay = ? WHERE user_id = ?",
            [casual, sick, lwp, application.user_id]
          );
        } else {
          await queryDB(
            "INSERT INTO leave_balances (user_id, casual_leave, sick_leave, leave_without_pay) VALUES (?, ?, ?, ?)",
            [application.user_id, casual, sick, lwp]
          );
        }
      }

      await queryDB(
        "UPDATE leave_applications SET status = ?, remarks = ?, decided_by = ?, decided_at = NOW() WHERE id = ?",
        [action === "approve" ? "approved" : "rejected", trimmedRemarks, req.user.id, req.params.id]
      );

      // Notify the applicant via their Alerts bell (web + mobile, same
      // component). First alert type wired up — more modules to follow later.
      const leaveTypeLabel =
        application.leave_type === "casual" ? "Casual" : application.leave_type === "sick" ? "Sick" : "Leave Without Pay";
      await createAlert(queryDB, {
        userId: application.user_id,
        type: "leave_application",
        title: action === "approve" ? "Leave Application Approved" : "Leave Application Rejected",
        message:
          action === "approve"
            ? `Your ${leaveTypeLabel} Leave (${application.start_date} to ${application.end_date}) has been approved.`
            : `Your ${leaveTypeLabel} Leave (${application.start_date} to ${application.end_date}) was rejected.${
                trimmedRemarks ? ` Reason: ${trimmedRemarks}` : ""
              }`,
        relatedType: "leave_application",
        relatedId: application.id
      });

      res.json({ success: true, status: action === "approve" ? "approved" : "rejected" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}