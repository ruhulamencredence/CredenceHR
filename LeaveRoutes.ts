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
}

export function registerLeaveRoutes(app: Express, deps: LeaveRouteDeps) {
  const {
    authenticateToken,
    queryDB,
    requireAdmin,
    requireModule,
    getLeaveApplicationDeptScope,
    requireLeaveManager,
    hasLeaveManageAccess,
    getCurrentStepApprovers,
    createAlert,
    approveLeaveApplicationReliever,
    rejectLeaveApplicationReliever,
    isValidLeaveType,
    getLeaveTypeLabel,
    getLeaveTypeBalance,
    adjustLeaveTypeBalance
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
  app.post("/api/leave-categories", authenticateToken, requireLeaveManager, async (req: any, res) => {
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
  app.put("/api/leave-balances/bulk", authenticateToken, requireLeaveManager, async (req: any, res) => {
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

      // Resolve every custom category key to its id ONCE up front (creating
      // it if it's somehow missing) rather than once per account.
      const categoryIdByKey = new Map<string, number>();
      for (const key of Object.keys(customValues)) {
        categoryIdByKey.set(key, await findOrCreateCategoryByKey(key, req.user.id));
      }

      for (const userId of targetIds) {
        // Already-spent-this-year comes off the new total per account (both
        // the 3 fixed fields below and any custom category), so someone who
        // already took leave this year doesn't get handed the full fresh
        // quota on top of what they've used. Fetched once per account,
        // shared by both sections below.
        const used = Object.keys(fixedValues).length > 0 || Object.keys(customValues).length > 0
          ? await getUsedThisYear(userId)
          : null;

        if (Object.keys(fixedValues).length > 0) {
          // Fields NOT present in fixedValues keep the account's existing
          // stored value untouched.
          const existingRows: any = await queryDB("SELECT * FROM leave_balances WHERE user_id = ?", [userId]);
          const existing = existingRows[0];
          const nextCasual =
            fixedValues.casual_leave !== undefined
              ? Math.max(0, fixedValues.casual_leave - used!.casual)
              : Number(existing?.casual_leave || 0);
          const nextSick =
            fixedValues.sick_leave !== undefined
              ? Math.max(0, fixedValues.sick_leave - used!.sick)
              : Number(existing?.sick_leave || 0);
          const nextLwp =
            fixedValues.leave_without_pay !== undefined
              ? Math.max(0, fixedValues.leave_without_pay - used!.without_pay)
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

        // Same already-spent-this-year adjustment as the 3 fixed fields above
        // — a custom category can now actually be applied against (Leave
        // Type dropdown), so Set Balance in Bulk has to dock what's already
        // been taken this year the same way, or re-running it would hand
        // back the full fresh quota on top of leave already used.
        for (const key of Object.keys(customValues)) {
          const nextBalance = Math.max(0, customValues[key] - (used!.custom[key] || 0));
          await queryDB(
            "INSERT INTO leave_category_balances (user_id, category_id, balance) VALUES (?, ?, ?) " +
              "ON DUPLICATE KEY UPDATE balance = VALUES(balance)",
            [userId, categoryIdByKey.get(key), nextBalance]
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
        ...fixedValues
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
      const rows: any = await queryDB("SELECT can_view_leave_application FROM users WHERE id = ?", [req.user.id]);
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

      const currentBalance = await getLeaveTypeBalance(req.user.id, leave_type);
      if (dayCount > currentBalance) {
        return res.status(400).json({ error: `Day Count (${dayCount}) exceeds your remaining balance (${currentBalance}) for this Leave Type.` });
      }
      await adjustLeaveTypeBalance(req.user.id, leave_type, -dayCount);

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
}