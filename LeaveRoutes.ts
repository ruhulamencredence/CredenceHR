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
  // Same requireAdmin / requireModule(moduleKey) gates every other Admin Panel
  // module in server.ts uses — threaded through here for the 'leave_applications'
  // module's own read-only report (GET /api/leave-applications/report*), kept
  // separate from requireLeaveManager below (that's the can_manage_leave
  // toggle, a different feature).
  requireAdmin: (req: any, res: any, next: any) => Promise<any>;
  requireModule: (moduleKey: string) => any;
  // Department-wise scope for the 'leave_applications' module — see
  // leave_application_department_access table comment in server.ts's initDB().
  getLeaveApplicationDeptScope: (userId: number) => Promise<string[] | null>;
  requireLeaveManager: (req: any, res: any, next: any) => Promise<any>;
  // Finer-grained gate layered on top of requireLeaveManager above — one of
  // "edit_balance"/"bulk_set_balance"/"add_category"/"edit_policy"/
  // "year_settings"/"workflow_manage" (see LEAVE_MANAGE_LAYER_KEYS in
  // server.ts). Applied to each of Leave Manage's write routes below, one
  // layer per route.
  requireLeaveManagerLayer: (layer: "edit_balance" | "bulk_set_balance" | "add_category" | "edit_policy" | "year_settings" | "workflow_manage") => any;
  hasLeaveManageAccess: (userId: number, role: string) => Promise<boolean>;
  getCurrentStepApprovers: (request: any) => Promise<{ user_id: number; user_name: string | null }[]>;
  createAlert: (...args: any[]) => Promise<any>;
  approveLeaveApplicationReliever: (leaveId: number, relieverUserId: number, remarks: string | null) => Promise<any>;
  rejectLeaveApplicationReliever: (leaveId: number, relieverUserId: number, remarks: string | null) => Promise<any>;
  // Custom Leave Categories in Leave Type — shared with server.ts's own
  // finalizeLeaveApplicationApproval/rejectLeaveApplicationRecord/
  // approveLeaveApplicationReliever so every caller resolves a Leave Type
  // (fixed OR custom category key) the exact same way. See their doc
  // comments in server.ts for the full design.
  isValidLeaveType: (leaveType: string) => Promise<boolean>;
  getLeaveTypeLabel: (leaveType: string) => Promise<string>;
  getLeaveTypeBalance: (userId: number, leaveType: string) => Promise<number>;
  adjustLeaveTypeBalance: (userId: number, leaveType: string, delta: number) => Promise<void>;
  // Per-Leave-Category Policy (Leave Manage -> "Leave Policies") — used by
  // POST /api/leave-applications below to decide whether a Reliever is
  // required for this submission, and if not, to hand the application
  // straight to the Dynamic Approval Engine itself (the same two calls
  // approveLeaveApplicationReliever makes once a real Reliever approves).
  createTemplateApprovalRequest: (
    requestType: "conveyance" | "leave" | "timesheet",
    sourceType: "user_claim" | "attendance_correction" | "leave_application",
    sourceId: number,
    requestedBy: number
  ) => Promise<{ autoApproved: boolean; template: any | null }>;
  finalizeLeaveApplicationApproval: (leaveId: number, approvedBy: number | null, remarks: string | null) => Promise<void>;
}

export function registerLeaveRoutes(app: Express, deps: LeaveRouteDeps) {
  const {
    authenticateToken,
    queryDB,
    requireAdmin,
    requireModule,
    getLeaveApplicationDeptScope,
    requireLeaveManager,
    requireLeaveManagerLayer,
    hasLeaveManageAccess,
    getCurrentStepApprovers,
    createAlert,
    approveLeaveApplicationReliever,
    rejectLeaveApplicationReliever,
    isValidLeaveType,
    getLeaveTypeLabel,
    getLeaveTypeBalance,
    adjustLeaveTypeBalance,
    createTemplateApprovalRequest,
    finalizeLeaveApplicationApproval
  } = deps;

  // Every custom Leave Category defined so far, as a category_key -> label
  // map — used by the list endpoints below to attach leave_type_label to
  // each row in one query instead of an async getLeaveTypeLabel() call per
  // row. Fixed types use the same static labels getLeaveTypeLabel does.
  async function buildLeaveTypeLabelResolver(): Promise<(leaveType: string) => string> {
    const categories: any = await queryDB("SELECT id, category_key, label FROM leave_categories");
    const labelByKey = new Map<string, string>();
    for (const c of categories) labelByKey.set(c.category_key, c.label);
    return (leaveType: string) => {
      if (leaveType === "casual") return "Casual";
      if (leaveType === "sick") return "Sick";
      if (leaveType === "without_pay") return "Leave Without Pay";
      return labelByKey.get(leaveType) || leaveType;
    };
  }

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
  // custom: category_key -> days used this year, for any custom Leave
  // Category that's actually been applied for (Set Balance in Bulk/the
  // single-account PUT below can now dock this off a custom category's new
  // total the same way it already did for the 3 fixed ones — see both
  // callers below).
  async function getUsedThisYear(userId: number): Promise<{ casual: number; sick: number; without_pay: number; custom: Record<string, number> }> {
    const year = new Date().getFullYear();
    const rows: any = await queryDB(
      "SELECT leave_type, day_count FROM leave_applications WHERE user_id = ? AND status != 'rejected' AND YEAR(start_date) = ?",
      [userId, year]
    );
    const used = { casual: 0, sick: 0, without_pay: 0, custom: {} as Record<string, number> };
    for (const r of rows) {
      const dc = Number(r.day_count) || 0;
      if (r.leave_type === "casual") used.casual += dc;
      else if (r.leave_type === "sick") used.sick += dc;
      else if (r.leave_type === "without_pay") used.without_pay += dc;
      else used.custom[r.leave_type] = (used.custom[r.leave_type] || 0) + dc;
    }
    return used;
  }

  // Turns a Leave Category's display label into its stable slug/key — same
  // algorithm the frontend uses to preview the key before POSTing (see
  // LeaveManage.tsx's slugifyCategory), but this is the authoritative copy:
  // the server always derives the key itself from the label it stores/looks
  // up, never trusts one passed in from the client.
  function slugifyCategoryLabel(label: string): string {
    return (
      "custom_" +
      label
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
    );
  }

  // Resolves a Leave Category's key to its id, creating the category (with a
  // best-effort title-cased label derived from the key) if it doesn't exist
  // yet. Normally every key reaching here was already created via POST
  // /api/leave-categories when the admin added it in the bulk panel — this is
  // just a safety net so a stale/unknown key in a bulk-apply payload never
  // silently fails instead of being applied.
  async function findOrCreateCategoryByKey(key: string, createdBy: number): Promise<number> {
    const existing: any = await queryDB("SELECT id, category_key, label FROM leave_categories WHERE category_key = ?", [key]);
    if (existing.length > 0) return Number(existing[0].id);
    const fallbackLabel =
      key
        .replace(/^custom_/, "")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c: string) => c.toUpperCase())
        .trim() || key;
    const result: any = await queryDB(
      "INSERT INTO leave_categories (category_key, label, created_by) VALUES (?, ?, ?)",
      [key, fallbackLabel, createdBy]
    );
    return Number(result.insertId);
  }

  // Applies a set of fixed/custom category balances to many accounts at
  // once, docking whatever each account has already used this calendar year
  // off the new total (same "new total - already used, floored at 0" rule
  // getUsedThisYear's doc comment explains) — the exact inner loop PUT
  // /api/leave-balances/bulk below used to have inline, now shared with the
  // Leave Balance Workflow "Apply Now"/auto-rollover path
  // (applyAllActiveWorkflows below) so both ways of bulk-setting balances
  // can never drift out of sync.
  async function applyBalancesToTargets(
    targetIds: number[],
    fixedValues: Partial<Record<"casual_leave" | "sick_leave" | "leave_without_pay", number>>,
    customValues: Record<string, number>,
    actingUserId: number
  ): Promise<void> {
    const categoryIdByKey = new Map<string, number>();
    for (const key of Object.keys(customValues)) {
      categoryIdByKey.set(key, await findOrCreateCategoryByKey(key, actingUserId));
    }

    for (const userId of targetIds) {
      const used = await getUsedThisYear(userId);

      if (Object.keys(fixedValues).length > 0) {
        const existingRows: any = await queryDB("SELECT * FROM leave_balances WHERE user_id = ?", [userId]);
        const existing = existingRows[0];
        const nextCasual =
          fixedValues.casual_leave !== undefined ? Math.max(0, fixedValues.casual_leave - used.casual) : Number(existing?.casual_leave || 0);
        const nextSick =
          fixedValues.sick_leave !== undefined ? Math.max(0, fixedValues.sick_leave - used.sick) : Number(existing?.sick_leave || 0);
        const nextLwp =
          fixedValues.leave_without_pay !== undefined
            ? Math.max(0, fixedValues.leave_without_pay - used.without_pay)
            : Number(existing?.leave_without_pay || 0);

        if (existing) {
          await queryDB(
            "UPDATE leave_balances SET casual_leave = ?, sick_leave = ?, leave_without_pay = ? WHERE user_id = ?",
            [nextCasual, nextSick, nextLwp, userId]
          );
        } else {
          await queryDB(
            "INSERT INTO leave_balances (user_id, casual_leave, sick_leave, leave_without_pay) VALUES (?, ?, ?, ?)",
            [userId, nextCasual, nextSick, nextLwp]
          );
        }
      }

      for (const key of Object.keys(customValues)) {
        const nextBalance = Math.max(0, customValues[key] - (used.custom[key] || 0));
        await queryDB(
          "INSERT INTO leave_category_balances (user_id, category_id, balance) VALUES (?, ?, ?) " +
            "ON DUPLICATE KEY UPDATE balance = VALUES(balance)",
          [userId, categoryIdByKey.get(key), nextBalance]
        );
      }
    }
  }

  // Leave Manage -> "Leave Balance Workflows" — resolves every active
  // workflow's per-category balances onto the accounts it targets (General
  // -> every account, a Designation workflow -> every account whose Employee
  // Directory row has that Designation) and applies them via
  // applyBalancesToTargets above. General is always applied first so a
  // Designation workflow's own values for the categories it defines
  // naturally win (applied second, same accounts). Used by both the manual
  // "Apply Now" button (POST /api/leave-balance-workflows/apply) and the
  // year-end auto-rollover (checkAndRunLeaveYearRollover below). Returns how
  // many (workflow, account) balance writes actually happened, so callers can
  // tell "nothing to apply" apart from a real 0-account workflow.
  async function applyAllActiveWorkflows(actingUserId: number, onlyWorkflowId?: number): Promise<number> {
    const workflows: any = onlyWorkflowId
      ? await queryDB("SELECT * FROM leave_balance_workflows WHERE id = ? AND is_active = 1", [onlyWorkflowId])
      : await queryDB("SELECT * FROM leave_balance_workflows WHERE is_active = 1");
    if (workflows.length === 0) return 0;
    workflows.sort((a: any, b: any) => (a.scope_type === "general" ? 0 : 1) - (b.scope_type === "general" ? 0 : 1));

    const [users, employees, items] = await Promise.all([
      queryDB("SELECT id FROM users WHERE role IN ('admin', 'user')"),
      queryDB("SELECT * FROM all_employees WHERE user_id IS NOT NULL"),
      queryDB("SELECT * FROM leave_balance_workflow_items")
    ]);
    const designationByUserId = new Map<number, string>();
    for (const e of employees) {
      if (e.designation) designationByUserId.set(Number(e.user_id), String(e.designation).trim().toLowerCase());
    }
    const itemsByWorkflow = new Map<number, any[]>();
    for (const it of items) {
      const wid = Number(it.workflow_id);
      if (!itemsByWorkflow.has(wid)) itemsByWorkflow.set(wid, []);
      itemsByWorkflow.get(wid)!.push(it);
    }
    const allUserIds = users.map((u: any) => Number(u.id));

    let appliedCount = 0;
    for (const wf of workflows) {
      const targetIds =
        wf.scope_type === "general"
          ? allUserIds
          : allUserIds.filter((id: number) => designationByUserId.get(id) === String(wf.designation || "").trim().toLowerCase());
      if (targetIds.length === 0) continue;

      const wfItems = itemsByWorkflow.get(Number(wf.id)) || [];
      const fixedValues: Partial<Record<"casual_leave" | "sick_leave" | "leave_without_pay", number>> = {};
      const customValues: Record<string, number> = {};
      for (const it of wfItems) {
        const val = Number(it.balance_days) || 0;
        if (it.category_key === "casual_leave" || it.category_key === "sick_leave" || it.category_key === "leave_without_pay") {
          fixedValues[it.category_key as "casual_leave" | "sick_leave" | "leave_without_pay"] = val;
        } else {
          customValues[it.category_key] = val;
        }
      }
      if (Object.keys(fixedValues).length === 0 && Object.keys(customValues).length === 0) continue;

      await applyBalancesToTargets(targetIds, fixedValues, customValues, actingUserId);
      appliedCount += targetIds.length;
    }
    return appliedCount;
  }

  // Leave Manage -> "Year Settings" — MM-DD validation shared by GET/PUT
  // /api/leave-year-settings below. 2024 is just a leap-year canvas so Feb 29
  // validates/adds correctly; no actual year is stored.
  function normalizeMonthDay(value: any): string | null {
    const s = typeof value === "string" ? value.trim() : "";
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(s);
    if (!m) return null;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12) return null;
    const daysInMonth = new Date(2024, month, 0).getDate();
    if (day < 1 || day > daysInMonth) return null;
    return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function dayAfterMonthDay(monthDay: string): string {
    const [month, day] = monthDay.split("-").map(Number);
    const d = new Date(2024, month - 1, day);
    d.setDate(d.getDate() + 1);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // Runs once at startup and then every 6 hours (see setInterval near the
  // bottom of this function) — the closest thing to a real year-end cron job
  // this app has. A no-op unless Year Settings' auto_rollover is on AND
  // today has reached this year's start_month_day AND this calendar year
  // hasn't already been rolled over (last_rollover_year), so it's safe to
  // call this often; it only ever actually applies workflows once per year.
  async function checkAndRunLeaveYearRollover(): Promise<void> {
    try {
      const rows: any = await queryDB("SELECT * FROM leave_year_settings WHERE id = 1");
      const settings = rows[0];
      if (!settings || !Number(settings.auto_rollover)) return;

      const startMonthDay = normalizeMonthDay(settings.start_month_day) || "01-01";
      const [sm, sd] = startMonthDay.split("-").map(Number);
      const now = new Date();
      const currentYear = now.getFullYear();
      const startThisYear = new Date(currentYear, sm - 1, sd);
      if (now < startThisYear) return;

      const lastRolloverYear = settings.last_rollover_year ? Number(settings.last_rollover_year) : null;
      if (lastRolloverYear === currentYear) return;

      const superadmins: any = await queryDB("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1");
      const actingUserId = superadmins[0] ? Number(superadmins[0].id) : settings.updated_by ? Number(settings.updated_by) : null;
      if (!actingUserId) return;

      await applyAllActiveWorkflows(actingUserId);
      await queryDB("UPDATE leave_year_settings SET last_rollover_year = ? WHERE id = 1", [currentYear]);
      console.log(`✅ Leave Year auto-rollover applied for ${currentYear} (start date ${startMonthDay}).`);
    } catch (err: any) {
      console.warn("⚠️ Leave Year auto-rollover check failed: " + err.message);
    }
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
      const [rows, categories, myCategoryBalances] = await Promise.all([
        queryDB("SELECT * FROM leave_balances WHERE user_id = ?", [req.user.id]),
        queryDB("SELECT id, category_key, label FROM leave_categories"),
        queryDB("SELECT * FROM leave_category_balances WHERE user_id = ?", [req.user.id])
      ]);
      const b = rows[0];
      const categoryById = new Map<number, any>();
      for (const c of categories) categoryById.set(Number(c.id), c);
      const customLeaves = myCategoryBalances
        .map((cb: any) => {
          const cat = categoryById.get(Number(cb.category_id));
          return cat ? { key: cat.category_key, label: cat.label, balance: Number(cb.balance) } : null;
        })
        .filter(Boolean);
      res.json([{
        user_id: req.user.id,
        user_name: req.user.name,
        user_role: req.user.role,
        casual_leave: b ? Number(b.casual_leave) : 0,
        sick_leave: b ? Number(b.sick_leave) : 0,
        leave_without_pay: b ? Number(b.leave_without_pay) : 0,
        updated_at: b ? b.updated_at : null,
        custom_leaves: customLeaves
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
        const [balances, employees, categories, categoryBalances] = await Promise.all([
          queryDB("SELECT * FROM leave_balances"),
          // Department comes from the Employee Directory row linked to this
          // login account (all_employees.user_id) — no department column of
          // its own on users/leave_balances, so "Set Balance in Bulk" below
          // can group/filter by it without a schema change.
          queryDB("SELECT * FROM all_employees"),
          queryDB("SELECT id, category_key, label FROM leave_categories"),
          queryDB("SELECT * FROM leave_category_balances")
        ]);
        const byUser = new Map<number, any>();
        for (const b of balances) byUser.set(Number(b.user_id), b);
        const departmentByUserId = new Map<number, string>();
        for (const e of employees) {
          if (e.user_id != null && e.department) departmentByUserId.set(Number(e.user_id), e.department);
        }
        const categoryById = new Map<number, any>();
        for (const c of categories) categoryById.set(Number(c.id), c);
        const customLeavesByUser = new Map<number, { key: string; label: string; balance: number }[]>();
        for (const cb of categoryBalances) {
          const cat = categoryById.get(Number(cb.category_id));
          if (!cat) continue;
          const uid = Number(cb.user_id);
          if (!customLeavesByUser.has(uid)) customLeavesByUser.set(uid, []);
          customLeavesByUser.get(uid)!.push({ key: cat.category_key, label: cat.label, balance: Number(cb.balance) });
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
            updated_at: b ? b.updated_at : null,
            custom_leaves: customLeavesByUser.get(Number(u.id)) || []
          };
        }));
      } else {
        const [rows, categories, myCategoryBalances] = await Promise.all([
          queryDB("SELECT * FROM leave_balances WHERE user_id = ?", [req.user.id]),
          queryDB("SELECT id, category_key, label FROM leave_categories"),
          queryDB("SELECT * FROM leave_category_balances WHERE user_id = ?", [req.user.id])
        ]);
        const b = rows[0];
        const categoryById = new Map<number, any>();
        for (const c of categories) categoryById.set(Number(c.id), c);
        const customLeaves = myCategoryBalances
          .map((cb: any) => {
            const cat = categoryById.get(Number(cb.category_id));
            return cat ? { key: cat.category_key, label: cat.label, balance: Number(cb.balance) } : null;
          })
          .filter(Boolean);
        res.json([{
          user_id: req.user.id,
          user_name: req.user.name,
          user_role: req.user.role,
          casual_leave: b ? Number(b.casual_leave) : 0,
          sick_leave: b ? Number(b.sick_leave) : 0,
          leave_without_pay: b ? Number(b.leave_without_pay) : 0,
          updated_at: b ? b.updated_at : null,
          custom_leaves: customLeaves
        }]);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Leave Manage -> Set Balance in Bulk -> Add Category, AND Self Service ->
  // Leave Application's Leave Type dropdown (NewLeaveApplicationModal) —
  // every custom Leave Category defined so far. Open to ANY authenticated
  // account (not just Leave Managers, unlike POST below): a plain User still
  // needs this list to see/apply for a custom category on their own Leave
  // Application, the same way they can already see Casual/Sick/LWP.
  app.get("/api/leave-categories", authenticateToken, async (req: any, res) => {
    try {
      const rows: any = await queryDB("SELECT id, category_key, label FROM leave_categories ORDER BY label ASC");
      res.json(rows.map((r: any) => ({ id: Number(r.id), key: r.category_key, label: r.label })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST: define a new custom Leave Category. The key is always derived
  // server-side from the label (slugifyCategoryLabel) — never trusts a key
  // from the client. If a category with the same resulting key already
  // exists (e.g. two Leave Managers typed the same/similar name), that
  // existing one is handed back instead of erroring, so "Add Category" in
  // the bulk panel always ends up pointing at one shared category.
  app.post("/api/leave-categories", authenticateToken, requireLeaveManager, requireLeaveManagerLayer("add_category"), async (req: any, res) => {
    try {
      const label = typeof req.body?.label === "string" ? req.body.label.trim().slice(0, 100) : "";
      if (!label) return res.status(400).json({ error: "Category name is required." });
      const key = slugifyCategoryLabel(label);
      if (key === "custom_") {
        return res.status(400).json({ error: "Category name must contain at least one letter or number." });
      }

      const existing: any = await queryDB("SELECT id, category_key, label FROM leave_categories WHERE category_key = ?", [key]);
      if (existing.length > 0) {
        return res.json({ id: Number(existing[0].id), key: existing[0].category_key, label: existing[0].label });
      }

      const result: any = await queryDB(
        "INSERT INTO leave_categories (category_key, label, created_by) VALUES (?, ?, ?)",
        [key, label, req.user.id]
      );
      res.json({ id: Number(result.insertId), key, label });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-Leave-Category Policy (Leave Manage -> "Leave Policies"). Open to ANY
  // authenticated account, same reasoning as GET /api/leave-categories above
  // — NewLeaveApplicationModal reads this too (to hide the Reliever picker
  // and show the advance-notice minimum for whatever Leave Type is picked),
  // not just the Leave Manage screen. A category with no row yet (a custom
  // category defined before this feature existed) is filled in with the same
  // "no restriction, Reliever required" defaults leave_category_policies is
  // seeded with, so callers never have to special-case a missing row.
  const DEFAULT_LEAVE_POLICY = { min_advance_notice_days: 0, reliever_required: true, max_consecutive_days: null as number | null, require_paid_leave_exhausted: false };
  async function getLeavePolicy(categoryKey: string) {
    const rows: any = await queryDB("SELECT * FROM leave_category_policies WHERE category_key = ?", [categoryKey]);
    if (rows.length === 0) return { category_key: categoryKey, ...DEFAULT_LEAVE_POLICY };
    const r = rows[0];
    return {
      category_key: categoryKey,
      min_advance_notice_days: Number(r.min_advance_notice_days) || 0,
      reliever_required: !!Number(r.reliever_required),
      max_consecutive_days: r.max_consecutive_days === null ? null : Number(r.max_consecutive_days),
      require_paid_leave_exhausted: !!Number(r.require_paid_leave_exhausted)
    };
  }

  app.get("/api/leave-policies", authenticateToken, async (req: any, res) => {
    try {
      const [fixedTypes, categories]: [any, any] = await Promise.all([
        Promise.resolve(["casual", "sick", "without_pay"]),
        queryDB("SELECT category_key FROM leave_categories")
      ]);
      const keys = [...fixedTypes, ...categories.map((c: any) => c.category_key)];
      const policies = await Promise.all(keys.map((k: string) => getLeavePolicy(k)));
      res.json(policies);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT: Leave Manager (requireLeaveManager — same gate as every other Leave
  // Manage write below) sets the policy for one Leave Type. Upserts so a
  // custom category can be configured the first time without a pre-existing
  // row.
  app.put("/api/leave-policies/:categoryKey", authenticateToken, requireLeaveManager, requireLeaveManagerLayer("edit_policy"), async (req: any, res) => {
    try {
      const categoryKey = String(req.params.categoryKey || "").trim();
      if (!categoryKey || !(await isValidLeaveType(categoryKey))) {
        return res.status(400).json({ error: "Unknown Leave Type." });
      }
      const minAdvanceNoticeDays = Math.max(0, Math.trunc(Number(req.body?.min_advance_notice_days)) || 0);
      const relieverRequired = !!req.body?.reliever_required;
      const maxConsecutiveDaysRaw = req.body?.max_consecutive_days;
      const maxConsecutiveDays =
        maxConsecutiveDaysRaw === null || maxConsecutiveDaysRaw === undefined || maxConsecutiveDaysRaw === ""
          ? null
          : Math.max(1, Math.trunc(Number(maxConsecutiveDaysRaw)) || 1);
      const requirePaidLeaveExhausted = !!req.body?.require_paid_leave_exhausted;

      await queryDB(
        `INSERT INTO leave_category_policies (category_key, min_advance_notice_days, reliever_required, max_consecutive_days, require_paid_leave_exhausted, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE min_advance_notice_days = VALUES(min_advance_notice_days), reliever_required = VALUES(reliever_required),
           max_consecutive_days = VALUES(max_consecutive_days), require_paid_leave_exhausted = VALUES(require_paid_leave_exhausted), updated_by = VALUES(updated_by)`,
        [categoryKey, minAdvanceNoticeDays, relieverRequired, maxConsecutiveDays, requirePaidLeaveExhausted, req.user.id]
      );
      res.json(await getLeavePolicy(categoryKey));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT: "Set Balance in Bulk" — apply Casual/Sick/Leave-without-Pay and/or any
  // custom Leave Category balances to many accounts in one go instead of
  // editing rows one at a time. req.body.departments: [] or omitted = every
  // Admin/User account (Global); otherwise every account linked (via
  // all_employees.user_id) to one of the given Department names. Same
  // requireLeaveManager gate as the single-account PUT below.
  //
  // Every field is now OPTIONAL — only casual_leave/sick_leave/
  // leave_without_pay keys actually present in the body get touched; the
  // others are left exactly as they already are in the DB. This lets the bulk
  // panel apply e.g. just a custom "Maternity Leave" balance without also
  // being forced to re-enter the three fixed ones. custom_categories (if
  // present) is a { [category_key]: balance } map — see
  // findOrCreateCategoryByKey above for how unknown keys are handled.
  // NOTE: registered BEFORE PUT /api/leave-balances/:userId on purpose — Express
  // matches routes in registration order and :userId would otherwise swallow
  // this exact path (matching "bulk" as if it were a userId) and 404 first.
  app.put("/api/leave-balances/bulk", authenticateToken, requireLeaveManager, requireLeaveManagerLayer("bulk_set_balance"), async (req: any, res) => {
    try {
      const body = req.body || {};

      const fixedFieldKeys = ["casual_leave", "sick_leave", "leave_without_pay"] as const;
      const fixedValues: Partial<Record<(typeof fixedFieldKeys)[number], number>> = {};
      for (const field of fixedFieldKeys) {
        const raw = body[field];
        if (raw === undefined || raw === null || raw === "") continue;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ error: "Leave balances must be non-negative numbers." });
        }
        fixedValues[field] = n;
      }

      const customCategoriesInput =
        body.custom_categories && typeof body.custom_categories === "object" ? body.custom_categories : {};
      const customValues: Record<string, number> = {};
      for (const key of Object.keys(customCategoriesInput)) {
        const n = Number(customCategoriesInput[key]);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ error: "Leave balances must be non-negative numbers." });
        }
        customValues[key] = n;
      }

      if (Object.keys(fixedValues).length === 0 && Object.keys(customValues).length === 0) {
        return res.status(400).json({ error: "Enter at least one leave balance to apply." });
      }

      const departments: string[] = Array.isArray(body.departments)
        ? body.departments.map((d: any) => String(d).trim()).filter(Boolean)
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

      await applyBalancesToTargets(targetIds, fixedValues, customValues, req.user.id);

      res.json({
        success: true,
        updated_count: targetIds.length,
        // Note: these are the entered annual totals, not necessarily each
        // account's resulting balance — accounts with leave already taken
        // this year were adjusted down individually above. The Leave
        // Manage table is re-fetched right after this call, so it always
        // shows each account's real adjusted balance.
        ...fixedValues
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT: set one account's Casual/Sick/Leave-without-Pay balance. Superadmin or
  // can_manage_leave-granted only (requireLeaveManager) — a plain account can
  // never edit even its own row here.
  app.put("/api/leave-balances/:userId", authenticateToken, requireLeaveManager, requireLeaveManagerLayer("edit_balance"), async (req: any, res) => {
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

  // Gate for Self Service -> Leave Application (the Reliever picker and the
  // actual submit route below) — an account needs can_view_leave_application
  // (Superadmin implicit) before it can open/use the New Leave Application
  // flow at all, same on/off pattern as requireLeaveManager. NOT applied to
  // GET /api/leave-applications/mine — that route is also shared by
  // LeaveSummaryCard/LeaveReviewPage (gated separately by
  // can_view_leave_summary), so gating it here would wrongly hide those too.
  const requireLeaveApplicationAccess = async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Access token required" });
    if (req.user.role === "superadmin") return next();
    try {
      const rows: any = await queryDB("SELECT * FROM users WHERE id = ?", [req.user.id]);
      if (rows.length > 0 && !!Number(rows[0].can_view_leave_application)) return next();
      return res.status(403).json({ error: "You don't have access to Leave Application. Ask your Superadmin to grant it." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

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
  app.get("/api/leave-applications/relievers", authenticateToken, requireLeaveApplicationAccess, async (req: any, res) => {
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
      const leaveTypeLabelFor = await buildLeaveTypeLabelResolver();
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
            reliever_name: r.reliever_name || null,
            leave_type_label: leaveTypeLabelFor(r.leave_type)
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
  app.post("/api/leave-applications", authenticateToken, requireLeaveApplicationAccess, async (req: any, res) => {
    try {
      const {
        leave_type, start_date, end_date, is_continuous, is_prefix, is_suffix,
        is_half_day, include_extra_work_dates, is_foreign_leave, purpose, reliever_id
      } = req.body || {};

      if (typeof leave_type !== "string" || !(await isValidLeaveType(leave_type))) {
        return res.status(400).json({ error: "Select a valid Leave Type." });
      }
      if (!start_date || !end_date || String(end_date) < String(start_date)) {
        return res.status(400).json({ error: "Start Date and End Date are required, and End Date can't be before Start Date." });
      }
      const trimmedPurpose = typeof purpose === "string" ? purpose.trim() : "";
      if (!trimmedPurpose) return res.status(400).json({ error: "Purpose is required." });

      // Per-Leave-Category Policy (Leave Manage -> "Leave Policies") — every
      // rule below is enforced here, server-side, never just hidden/validated
      // in the form, since a tampered client request must not be able to skip
      // it either.
      const policy = await getLeavePolicy(leave_type);

      // Advance notice: Start Date must be at least N calendar days from today.
      if (policy.min_advance_notice_days > 0) {
        const todayRows: any = await queryDB("SELECT CURDATE() AS today");
        const todayStr = String(todayRows[0].today).slice(0, 10);
        const today = new Date(`${todayStr}T00:00:00`);
        const start = new Date(`${start_date}T00:00:00`);
        const noticeDays = Math.round((start.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        if (noticeDays < policy.min_advance_notice_days) {
          return res.status(400).json({
            error: `This Leave Type must be applied at least ${policy.min_advance_notice_days} day${policy.min_advance_notice_days === 1 ? "" : "s"} before the Start Date.`
          });
        }
      }

      let relieverUserId: number | null = null;
      if (policy.reliever_required) {
        relieverUserId = Number(reliever_id);
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

      if (policy.max_consecutive_days !== null && dayCount > policy.max_consecutive_days) {
        return res.status(400).json({
          error: `This Leave Type allows at most ${policy.max_consecutive_days} consecutive day${policy.max_consecutive_days === 1 ? "" : "s"} per application.`
        });
      }

      // Leave-Without-Pay style rule: only once Casual AND Sick are both 0.
      if (policy.require_paid_leave_exhausted) {
        const [casualBalance, sickBalance] = await Promise.all([
          getLeaveTypeBalance(req.user.id, "casual"),
          getLeaveTypeBalance(req.user.id, "sick")
        ]);
        if (casualBalance > 0 || sickBalance > 0) {
          return res.status(400).json({ error: "You must exhaust your Casual Leave and Sick Leave balances before applying for this Leave Type." });
        }
      }

      const currentBalance = await getLeaveTypeBalance(req.user.id, leave_type);
      if (dayCount > currentBalance) {
        return res.status(400).json({ error: `Day Count (${dayCount}) exceeds your remaining balance (${currentBalance}) for this Leave Type.` });
      }
      await adjustLeaveTypeBalance(req.user.id, leave_type, -dayCount);

      const result: any = await queryDB(
        `INSERT INTO leave_applications
          (user_id, leave_type, start_date, end_date, day_count, is_continuous, is_prefix, is_suffix, is_half_day, include_extra_work_dates, is_foreign_leave, purpose, approver_id, status, apply_date, reliever_id, reliever_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', CURDATE(), ?, ?)`,
        [
          req.user.id, leave_type, start_date, end_date, dayCount,
          !!is_continuous, !!is_prefix, !!is_suffix, !!is_half_day, !!include_extra_work_dates, !!is_foreign_leave,
          trimmedPurpose, relieverUserId, relieverUserId ? "pending" : null
        ]
      );

      if (relieverUserId) {
        // Reliever workflow — the request sits waiting on the picked Reliever
        // first; the Dynamic Approval Engine (createTemplateApprovalRequest)
        // only gets invoked once that Reliever Approves — see
        // approveLeaveApplicationReliever / POST
        // /api/leave-applications/:id/reliever-decision below.
        await createAlert(queryDB, {
          userId: relieverUserId,
          type: "leave_application",
          title: "You've Been Selected as Reliever",
          message: `${req.user.name} selected you as Reliever for their Leave Application (${start_date} to ${end_date}). Please review it.`,
          relatedType: "leave_application",
          relatedId: result.insertId
        });
      } else {
        // This Leave Type's policy doesn't require a Reliever — skip straight
        // to the Dynamic Approval Engine, exactly what approveLeaveApplicationReliever
        // does once a real Reliever approves.
        const { autoApproved } = await createTemplateApprovalRequest("leave", "leave_application", result.insertId, req.user.id);
        if (autoApproved) {
          await finalizeLeaveApplicationApproval(result.insertId, null, "Auto-approved (no Approval Template configured for Leave, and no Reliever required for this Leave Type).");
        }
      }

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
      const leaveTypeLabelFor = await buildLeaveTypeLabelResolver();
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
          // Passed its first Approval Layer (the Department Supervisor
          // auto-layer when the applicant's Department has one configured,
          // otherwise the Template's own first Layer) — true once current_step
          // has moved past step 1, or the whole chain is already fully
          // 'approved' (a superset of "passed step 1"). Used by the Admin
          // Dashboard's On Leave Today/Tomorrow counts and Leave Calendar so
          // an application already cleared by the first reviewer shows as a
          // real Leave instead of staying "Pending" for however many more
          // Layers are left above it — see AdminDashboard.tsx.
          const supervisorLayerApproved =
            a.status === "approved" || (!!ar && ar.status === "pending" && currentStep != null && currentStep > 1);
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
            supervisor_layer_approved: supervisorLayerApproved,
            reliever_name: a.reliever_id ? (userMap.get(Number(a.reliever_id))?.name || null) : null,
            reliever_status: a.reliever_status || null,
            leave_type_label: leaveTypeLabelFor(a.leave_type)
          };
        })
      );
      res.json(enriched);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Monthly Leave Application report (Admin Panel -> Users -> Module Access ->
  // "Monthly Leave Application"). Gated by its own 'leave_applications'
  // module — separate from can_manage_leave (Leave Manage/Leave Balances,
  // above) and from the old approver-based GET /api/leave-applications /
  // "Leave Approvals" page — so a Superadmin can grant just "see every Leave
  // Application" (optionally narrowed to one or more Departments) to an Admin
  // OR a plain User account, without also handing them Approve/Reject power
  // or a Leave-balance-editing role. requireAdmin here also lets a plain
  // 'user' role through once they hold ANY module (same convention every
  // other Admin Panel tab uses), so this module works for role 'user' too,
  // exactly as the example in the spec asks for.
  //
  // Distinct Department list for this report's Department filter dropdown —
  // same plain-text `department` mirror column (all_employees.department)
  // GET /api/attendance/report/departments already reads, kept in sync with
  // the structured Department by resolveEmployeeDepartment. A Superadmin, or
  // an Admin/User with no scope rows at all (see getLeaveApplicationDeptScope),
  // sees every real Department; a scoped account's dropdown only ever offers
  // the Department(s) they've actually been granted.
  app.get("/api/leave-applications/report/departments", authenticateToken, requireAdmin, requireModule("leave_applications"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT DISTINCT department FROM all_employees WHERE user_id IS NOT NULL AND department IS NOT NULL AND department <> ''");
      let departmentsList = rows.map((r: any) => r.department).sort((a: string, b: string) => a.localeCompare(b));

      if (req.user.role !== "superadmin") {
        const scope = await getLeaveApplicationDeptScope(req.user.id);
        if (scope) {
          const allowed = new Set(scope);
          departmentsList = departmentsList.filter((d: string) => allowed.has(d));
        }
      }

      res.json(departmentsList);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET: every submitted Leave Application (every applicant, every status),
  // each enriched with the applicant's Department — unlike GET
  // /api/leave-applications above, visibility here is driven ENTIRELY by the
  // Department scope, never by who the Approver is. A Superadmin, or an
  // Admin/User with no scope rows at all, sees every application; a scoped
  // account only ever sees applications from accounts whose linked Employee
  // Directory row (all_employees.user_id) has a Department they've been
  // granted. An applicant with no linked Employee row (so no Department at
  // all) is only ever visible to an unrestricted (unscoped) viewer — a
  // scoped account can't accidentally see them just because they're
  // "uncategorized". An optional ?department= filter narrows further (or is
  // rejected 403 if it names a Department outside the caller's own scope,
  // same convention GET /api/attendance/report/monthly uses).
  app.get("/api/leave-applications/report", authenticateToken, requireAdmin, requireModule("leave_applications"), async (req: any, res) => {
    try {
      const requestedDepartment = req.query.department ? String(req.query.department).trim() : null;

      const deptScope = req.user.role === "superadmin" ? null : await getLeaveApplicationDeptScope(req.user.id);
      if (deptScope && requestedDepartment && !deptScope.includes(requestedDepartment)) {
        return res.status(403).json({ error: "You don't have access to this Department's Leave Applications." });
      }

      const [applications, users, employees, approvalRequests] = await Promise.all([
        queryDB("SELECT * FROM leave_applications ORDER BY created_at DESC"),
        queryDB("SELECT id, name, role FROM users"),
        queryDB("SELECT user_id, department FROM all_employees WHERE user_id IS NOT NULL"),
        queryDB("SELECT * FROM approval_requests WHERE source_type = 'leave_application'")
      ]);
      const userMap = new Map<number, any>(users.map((u: any) => [Number(u.id), u]));
      const departmentByUserId = new Map<number, string>();
      for (const e of employees) {
        if (e.user_id != null && e.department) departmentByUserId.set(Number(e.user_id), e.department);
      }
      const approvalByLeaveId = new Map<number, any>(approvalRequests.map((ar: any) => [Number(ar.source_id), ar]));
      const leaveTypeLabelFor = await buildLeaveTypeLabelResolver();

      const visible = applications.filter((a: any) => {
        const dept = departmentByUserId.get(Number(a.user_id)) || null;
        if (requestedDepartment) return dept === requestedDepartment;
        if (!deptScope) return true;
        return !!dept && deptScope.includes(dept);
      });

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
            department: departmentByUserId.get(Number(a.user_id)) || null,
            approver_name: approverName,
            decided_by_name: a.decided_by ? (userMap.get(Number(a.decided_by))?.name || null) : null,
            current_step: currentStep,
            total_steps: totalSteps,
            reliever_name: a.reliever_id ? (userMap.get(Number(a.reliever_id))?.name || null) : null,
            reliever_status: a.reliever_status || null,
            leave_type_label: leaveTypeLabelFor(a.leave_type)
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
        await adjustLeaveTypeBalance(application.user_id, application.leave_type, Number(application.day_count));
      }

      await queryDB(
        "UPDATE leave_applications SET status = ?, remarks = ?, decided_by = ?, decided_at = NOW() WHERE id = ?",
        [action === "approve" ? "approved" : "rejected", trimmedRemarks, req.user.id, req.params.id]
      );

      // Notify the applicant via their Alerts bell (web + mobile, same
      // component). First alert type wired up — more modules to follow later.
      const leaveTypeLabel = await getLeaveTypeLabel(application.leave_type);
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

  // Leave Manage -> "Year Settings". GET is Leave-Manager-only (unlike
  // leave-categories/leave-policies above, nothing outside Leave Manage
  // itself needs this).
  app.get("/api/leave-year-settings", authenticateToken, requireLeaveManager, async (req: any, res) => {
    try {
      const rows: any = await queryDB("SELECT * FROM leave_year_settings WHERE id = 1");
      const r = rows[0];
      res.json({
        close_month_day: r?.close_month_day || "12-31",
        start_month_day: r?.start_month_day || "01-01",
        auto_rollover: !!Number(r?.auto_rollover || 0),
        last_rollover_year: r?.last_rollover_year ?? null
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT: close_month_day is required; start_month_day is optional — if
  // omitted, it's auto-suggested as the very next day after close_month_day
  // (the same suggestion the frontend already shows before saving, computed
  // again here so a client that skips it still gets a sane value).
  app.put("/api/leave-year-settings", authenticateToken, requireLeaveManager, requireLeaveManagerLayer("year_settings"), async (req: any, res) => {
    try {
      const body = req.body || {};
      const closeMonthDay = normalizeMonthDay(body.close_month_day);
      if (!closeMonthDay) return res.status(400).json({ error: "Year Close Date must be a valid date (MM-DD)." });
      const startMonthDay =
        body.start_month_day !== undefined && body.start_month_day !== null && String(body.start_month_day).trim() !== ""
          ? normalizeMonthDay(body.start_month_day)
          : dayAfterMonthDay(closeMonthDay);
      if (!startMonthDay) return res.status(400).json({ error: "Year Start Date must be a valid date (MM-DD)." });
      const autoRollover = !!body.auto_rollover;

      await queryDB(
        `INSERT INTO leave_year_settings (id, close_month_day, start_month_day, auto_rollover, updated_by) VALUES (1, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE close_month_day = VALUES(close_month_day), start_month_day = VALUES(start_month_day),
           auto_rollover = VALUES(auto_rollover), updated_by = VALUES(updated_by)`,
        [closeMonthDay, startMonthDay, autoRollover, req.user.id]
      );

      const rows: any = await queryDB("SELECT * FROM leave_year_settings WHERE id = 1");
      const r = rows[0];
      res.json({
        close_month_day: r.close_month_day,
        start_month_day: r.start_month_day,
        auto_rollover: !!Number(r.auto_rollover),
        last_rollover_year: r.last_rollover_year ?? null
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Leave Manage -> "Leave Balance Workflows". GET returns every workflow
  // (General first) with its per-category items already resolved to labels,
  // plus the distinct Designations found in the Employee Directory (for the
  // "new Designation workflow" picker) — Leave-Manager-only, same reasoning
  // as Year Settings above.
  app.get("/api/leave-balance-workflows", authenticateToken, requireLeaveManager, async (req: any, res) => {
    try {
      const [workflows, items, customCategories, employees] = await Promise.all([
        queryDB("SELECT * FROM leave_balance_workflows"),
        queryDB("SELECT * FROM leave_balance_workflow_items"),
        queryDB("SELECT id, category_key, label FROM leave_categories"),
        queryDB("SELECT DISTINCT designation FROM all_employees WHERE designation IS NOT NULL AND designation <> ''")
      ]);
      const labelByKey = new Map<string, string>([
        ["casual_leave", "Casual Leave"],
        ["sick_leave", "Sick Leave"],
        ["leave_without_pay", "Leave without Pay"]
      ]);
      for (const c of customCategories) labelByKey.set(c.category_key, c.label);

      const sorted = [...workflows].sort((a: any, b: any) => {
        if (a.scope_type === "general" && b.scope_type !== "general") return -1;
        if (a.scope_type !== "general" && b.scope_type === "general") return 1;
        return String(a.name || "").localeCompare(String(b.name || ""));
      });

      res.json({
        workflows: sorted.map((wf: any) => ({
          id: Number(wf.id),
          name: wf.name,
          scope_type: wf.scope_type,
          designation: wf.designation || null,
          is_active: !!Number(wf.is_active),
          items: items
            .filter((it: any) => Number(it.workflow_id) === Number(wf.id))
            .map((it: any) => ({
              category_key: it.category_key,
              label: labelByKey.get(it.category_key) || it.category_key,
              balance_days: Number(it.balance_days)
            }))
        })),
        designations: (employees as any[]).map((e: any) => String(e.designation)).sort((a: string, b: string) => a.localeCompare(b))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST: create a new Designation-scoped workflow shell (General already
  // exists — seeded once at startup, id=1, never created here). Items are
  // added afterwards via PUT below, same "create the shell, then edit it"
  // flow leave-categories/leave-policies already use.
  app.post("/api/leave-balance-workflows", authenticateToken, requireLeaveManager, requireLeaveManagerLayer("workflow_manage"), async (req: any, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 100) : "";
      const designation = typeof req.body?.designation === "string" ? req.body.designation.trim().slice(0, 255) : "";
      if (!name) return res.status(400).json({ error: "Workflow name is required." });
      if (!designation) return res.status(400).json({ error: "Designation is required for a new workflow." });

      const existing: any = await queryDB(
        "SELECT id FROM leave_balance_workflows WHERE scope_type = 'designation' AND LOWER(designation) = LOWER(?)",
        [designation]
      );
      if (existing.length > 0) {
        return res.status(400).json({ error: `A workflow for "${designation}" already exists.` });
      }

      const result: any = await queryDB(
        "INSERT INTO leave_balance_workflows (name, scope_type, designation, is_active, created_by) VALUES (?, 'designation', ?, 1, ?)",
        [name, designation, req.user.id]
      );
      res.json({ id: Number(result.insertId), name, scope_type: "designation", designation, is_active: true, items: [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT: rename/toggle a workflow and/or replace its items in one call.
  // General (id=1, scope_type 'general') keeps its name/designation locked —
  // only its items and is_active can change. items, when present, fully
  // REPLACES this workflow's per-category balances (delete-then-insert,
  // simpler and safer than trying to diff against what's already there).
  app.put("/api/leave-balance-workflows/:id", authenticateToken, requireLeaveManager, requireLeaveManagerLayer("workflow_manage"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const rows: any = await queryDB("SELECT * FROM leave_balance_workflows WHERE id = ?", [id]);
      const workflow = rows[0];
      if (!workflow) return res.status(404).json({ error: "Workflow not found." });

      if (workflow.scope_type !== "general") {
        if (typeof req.body?.name === "string" && req.body.name.trim()) {
          await queryDB("UPDATE leave_balance_workflows SET name = ? WHERE id = ?", [req.body.name.trim().slice(0, 100), id]);
        }
        if (typeof req.body?.designation === "string" && req.body.designation.trim()) {
          const designation = req.body.designation.trim().slice(0, 255);
          const clash: any = await queryDB(
            "SELECT id FROM leave_balance_workflows WHERE scope_type = 'designation' AND LOWER(designation) = LOWER(?) AND id != ?",
            [designation, id]
          );
          if (clash.length > 0) return res.status(400).json({ error: `A workflow for "${designation}" already exists.` });
          await queryDB("UPDATE leave_balance_workflows SET designation = ? WHERE id = ?", [designation, id]);
        }
      }
      if (req.body?.is_active !== undefined) {
        await queryDB("UPDATE leave_balance_workflows SET is_active = ? WHERE id = ?", [req.body.is_active ? 1 : 0, id]);
      }

      if (Array.isArray(req.body?.items)) {
        const items: { category_key: string; balance_days: number }[] = [];
        for (const raw of req.body.items) {
          const categoryKey = typeof raw?.category_key === "string" ? raw.category_key.trim() : "";
          if (!categoryKey) continue;
          const balanceDays = Number(raw?.balance_days);
          if (!Number.isFinite(balanceDays) || balanceDays < 0) {
            return res.status(400).json({ error: "Each Leave Balance Workflow amount must be a non-negative number." });
          }
          items.push({ category_key: categoryKey, balance_days: balanceDays });
        }
        await queryDB("DELETE FROM leave_balance_workflow_items WHERE workflow_id = ?", [id]);
        for (const item of items) {
          await queryDB("INSERT INTO leave_balance_workflow_items (workflow_id, category_key, balance_days) VALUES (?, ?, ?)", [
            id,
            item.category_key,
            item.balance_days
          ]);
        }
      }

      const [updatedRows, updatedItems]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM leave_balance_workflows WHERE id = ?", [id]),
        queryDB("SELECT * FROM leave_balance_workflow_items WHERE workflow_id = ?", [id])
      ]);
      const wf = updatedRows[0];
      res.json({
        id: Number(wf.id),
        name: wf.name,
        scope_type: wf.scope_type,
        designation: wf.designation || null,
        is_active: !!Number(wf.is_active),
        items: updatedItems.map((it: any) => ({ category_key: it.category_key, balance_days: Number(it.balance_days) }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE: Designation-scoped workflows only — General (id=1) can never be
  // removed, it's the always-present fallback every account without a
  // matching Designation workflow still gets.
  app.delete("/api/leave-balance-workflows/:id", authenticateToken, requireLeaveManager, requireLeaveManagerLayer("workflow_manage"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const rows: any = await queryDB("SELECT * FROM leave_balance_workflows WHERE id = ?", [id]);
      const workflow = rows[0];
      if (!workflow) return res.status(404).json({ error: "Workflow not found." });
      if (workflow.scope_type === "general") return res.status(400).json({ error: "The General workflow can't be deleted." });
      await queryDB("DELETE FROM leave_balance_workflows WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST: apply every active Leave Balance Workflow right now (General, then
  // each active Designation workflow) — the same thing the year-end
  // auto-rollover does automatically, triggered by hand. Optional
  // workflow_id applies just that one workflow instead of all of them.
  app.post("/api/leave-balance-workflows/apply", authenticateToken, requireLeaveManager, requireLeaveManagerLayer("workflow_manage"), async (req: any, res) => {
    try {
      const onlyId = req.body?.workflow_id !== undefined && req.body?.workflow_id !== null ? Number(req.body.workflow_id) : undefined;
      const appliedCount = await applyAllActiveWorkflows(req.user.id, onlyId);
      if (appliedCount === 0) {
        return res.status(400).json({ error: "No matching accounts, or the workflow(s) have no balances set yet." });
      }
      res.json({ success: true, updated_count: appliedCount });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Kick off the year-end auto-rollover check once at startup, then every 6
  // hours — see checkAndRunLeaveYearRollover's own doc comment above.
  checkAndRunLeaveYearRollover();
  setInterval(checkAndRunLeaveYearRollover, 6 * 60 * 60 * 1000);
}