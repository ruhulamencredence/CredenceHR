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
import type { AlertType } from "./Alerts";
import { setAccountBlocked } from "./AccountBlock";

// The clearance departments a new install starts with. The list itself is
// per company and editable (Exit / Offboarding -> Clearance Departments,
// layer "exit_clearance_setup"): exit_clearance_approvers holds one row per
// department with what it clears, its approver and its place in the list.
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
  requireModuleLayer: (moduleKey: "exit_offboarding", layer: "exit_dues" | "exit_pdf" | "exit_clearance_setup") => any;
  hasModuleLayer: (user: any, moduleKey: "exit_offboarding", layer: string) => Promise<boolean>;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  getAdminModules: (userId: number) => Promise<string[]>;
  createAlert: (
    queryDB: (sql: string, params?: any[]) => Promise<any>,
    params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }
  ) => Promise<void>;
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
  // Editable clearance departments: what each one clears and its order.
  for (const sql of [
    "ALTER TABLE exit_clearance_approvers ADD COLUMN item_label VARCHAR(255) NULL",
    "ALTER TABLE exit_clearance_approvers ADD COLUMN sort_order INT NOT NULL DEFAULT 0"
  ]) {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (err.code !== "ER_DUP_FIELDNAME") console.warn("⚠️ Could not extend exit_clearance_approvers: " + err.message);
    }
  }
  try {
    for (const [i, d] of CLEARANCE_DEPARTMENTS.entries()) {
      await dbPool.query("UPDATE exit_clearance_approvers SET item_label = ?, sort_order = ? WHERE department = ? AND item_label IS NULL", [d.item_label, i + 1, d.department]);
    }
  } catch (err: any) {
    console.warn("⚠️ Could not fill clearance department labels: " + err.message);
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
  // Which dues (loans / advances from other modules) HR has already added to
  // this settlement — see POST /api/exit-requests/:id/settlement/add-dues.
  try {
    await dbPool.query("ALTER TABLE final_settlements ADD COLUMN dues_json TEXT NULL");
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") console.warn("⚠️ Could not add final_settlements.dues_json column: " + err.message);
  }
}

// One thing an exiting Employee still has or owes in another module.
//   blocking — the settlement can't be marked Paid while it is open: an
//              asset not returned, a SIM still on, a loan / advance balance
//              not yet added to the settlement.
//   amount   — money the Employee owes (loans / advances) or is owed (claims).
export interface ExitDue {
  key: string;
  // "status" / "clearance" are not dues: they come from this exit itself
  // (settleBlockers) — clearance not started, a department not cleared yet.
  kind: "asset" | "sim" | "loan" | "loan_request" | "claim" | "bill" | "vehicle" | "status" | "clearance";
  label: string;
  detail: string | null;
  amount: number | null;
  blocking: boolean;
  added: boolean;
}

const money = (v: any) => Math.round((Number(v) || 0) * 100) / 100;

export function parseAddedDues(raw: any): { key: string; label: string; amount: number; added_at: string; added_by: number }[] {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.filter((x: any) => x && typeof x.key === "string") : [];
  } catch {
    return [];
  }
}

// Everything the exiting account (users.id) still has open elsewhere. Each
// source is read on its own and a missing table just adds nothing.
export async function collectExitDues(queryDB: (sql: string, params?: any[]) => Promise<any>, userId: number, settlement: any): Promise<ExitDue[]> {
  const safe = (sql: string, params?: any[]) => queryDB(sql, params).catch(() => [] as any[]);
  const emps: any[] = await safe("SELECT id, name FROM all_employees WHERE user_id = ?", [userId]);
  const empIds = new Set((emps || []).filter((e: any) => e).map((e: any) => Number(e.id)));
  const added = new Set(parseAddedDues(settlement?.dues_json).map((d) => d.key));
  const out: ExitDue[] = [];
  const [assignments, assets, sims, advances, requests, claims, bills, billItems, rides]: any[][] = await Promise.all([
    safe("SELECT * FROM asset_assignments WHERE employee_user_id = ?", [userId]),
    safe("SELECT id, name, asset_tag FROM assets"),
    safe("SELECT * FROM mobile_sims"),
    safe("SELECT * FROM employee_advances"),
    safe("SELECT * FROM advance_requests"),
    safe("SELECT id, user_id, claim_date, category, amount, status FROM user_claims WHERE user_id = ?", [userId]),
    safe("SELECT id, user_id, bill_date, is_disbursed FROM conveyance_bills WHERE user_id = ?", [userId]),
    safe("SELECT bill_id, amount FROM conveyance_bill_items"),
    safe("SELECT id, employee_user_id, purpose, ride_date, status FROM vehicle_requisitions WHERE employee_user_id = ?", [userId])
  ]);
  for (const a of (assignments || []).filter((x: any) => Number(x.employee_user_id) === userId && !x.returned_date)) {
    const asset = (assets || []).find((x: any) => Number(x.id) === Number(a.asset_id));
    out.push({
      key: `asset:${a.id}`,
      kind: "asset",
      label: asset ? `${asset.name}${asset.asset_tag ? ` (${asset.asset_tag})` : ""}` : `Asset #${a.asset_id}`,
      detail: `Assigned ${String(a.assigned_date || "").slice(0, 10)} — not returned`,
      amount: null,
      blocking: true,
      added: false
    });
  }
  for (const m of (sims || []).filter((x: any) => empIds.has(Number(x.employee_id)) && x.status === "active"))
    out.push({ key: `sim:${m.id}`, kind: "sim", label: `SIM ${m.phone_number} (${m.operator})`, detail: "Still active — turn it off or move it in Mobile Bill", amount: null, blocking: true, added: false });
  for (const a of (advances || []).filter((x: any) => empIds.has(Number(x.employee_id)) && x.status === "active")) {
    const balance = money(Number(a.total_amount) - Number(a.paid_amount || 0));
    if (balance <= 0) continue;
    const key = `loan:${a.id}`;
    out.push({
      key,
      kind: "loan",
      label: `Loan / advance #${a.id}${a.reason ? ` — ${a.reason}` : ""}`,
      detail: `৳${money(a.total_amount).toLocaleString("en-US")} given, ৳${money(a.paid_amount).toLocaleString("en-US")} repaid`,
      amount: balance,
      blocking: !added.has(key),
      added: added.has(key)
    });
  }
  for (const r of (requests || []).filter((x: any) => empIds.has(Number(x.employee_id)) && x.status === "pending"))
    out.push({
      key: `loan_request:${r.id}`,
      kind: "loan_request",
      label: `${r.request_kind === "loan" ? "Loan" : "Salary advance"} request #${r.id}`,
      detail: "Waiting for a decision",
      amount: money(r.total_amount),
      blocking: false,
      added: false
    });
  for (const c of (claims || []).filter((x: any) => Number(x.user_id) === userId && x.status === "pending"))
    out.push({ key: `claim:${c.id}`, kind: "claim", label: `${c.category || "Claim"} — ${String(c.claim_date || "").slice(0, 10)}`, detail: "Claim waiting for a decision", amount: money(c.amount), blocking: false, added: false });
  for (const b of (bills || []).filter((x: any) => Number(x.user_id) === userId && !Number(x.is_disbursed))) {
    const total = money((billItems || []).filter((i: any) => Number(i.bill_id) === Number(b.id)).reduce((t: number, i: any) => t + Number(i.amount || 0), 0));
    out.push({ key: `bill:${b.id}`, kind: "bill", label: `Conveyance bill ${String(b.bill_date || "").slice(0, 10)}`, detail: "Not paid out yet", amount: total || null, blocking: false, added: false });
  }
  for (const v of (rides || []).filter((x: any) => Number(x.employee_user_id) === userId && ["pending", "approved", "assigned", "ongoing"].includes(x.status)))
    out.push({ key: `vehicle:${v.id}`, kind: "vehicle", label: `Vehicle requisition — ${String(v.ride_date || "").slice(0, 10)}`, detail: v.purpose ? `${v.status}: ${v.purpose}` : v.status, amount: null, blocking: false, added: false });
  return out;
}

export function registerExitOffboardingRoutes(app: Express, deps: ExitOffboardingRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, hasModuleLayer, queryDB, getAdminModules, createAlert } = deps;
  const pdfGate = [authenticateToken, requireAdmin, requireModule("exit_offboarding"), requireModuleLayer("exit_offboarding", "exit_pdf")];
  const duesGate = [authenticateToken, requireAdmin, requireModule("exit_offboarding"), requireModuleLayer("exit_offboarding", "exit_dues")];
  const settlementOf = async (exitId: number) => {
    const rows: any[] = await queryDB("SELECT * FROM final_settlements");
    return rows.find((s: any) => Number(s.exit_id) === exitId) || null;
  };
  // The dues that stop a settlement being paid / an exit being settled.
  const blockingDues = async (exitRow: any) =>
    (await collectExitDues(queryDB, Number(exitRow.user_id), await settlementOf(Number(exitRow.id)))).filter((d) => d.blocking);
  // Everything that must be done before the Full & Final can be paid / the
  // exit settled: clearance started, every clearance department cleared, and
  // no blocking dues in other modules.
  const settleBlockers = async (exitRow: any): Promise<ExitDue[]> => {
    const out: ExitDue[] = [];
    if (exitRow.status !== "clearance" && exitRow.status !== "settled") {
      out.push({
        key: "status",
        kind: "status",
        label: exitRow.status === "cancelled" ? "This exit is cancelled" : "Clearance hasn't been started",
        detail: exitRow.status === "cancelled" ? "A cancelled exit can't be settled." : "Accept the exit with “Start Clearance” first.",
        amount: null,
        blocking: true,
        added: false
      });
    }
    const [items, users]: [any, any] = await Promise.all([queryDB("SELECT * FROM exit_clearance_items"), queryDB("SELECT id, name FROM users")]);
    for (const it of (items || []).filter((x: any) => Number(x.exit_id) === Number(exitRow.id) && !Number(x.is_cleared))) {
      const who = it.approver_user_id != null ? (users || []).find((u: any) => Number(u.id) === Number(it.approver_user_id))?.name : null;
      out.push({
        key: `clearance:${it.id}`,
        kind: "clearance",
        label: `${it.department} clearance not done`,
        detail: `${it.item_label}${who ? ` — waiting on ${who}` : " — no approver assigned"}`,
        amount: null,
        blocking: true,
        added: false
      });
    }
    return [...out, ...(await blockingDues(exitRow))];
  };
  const duesError = (blocking: ExitDue[]) =>
    `Can't settle yet — still open: ${blocking.map((d) => d.label + (d.kind === "loan" ? " (balance not added to the settlement)" : "")).join("; ")}. Clear them first.`;

  // This company's clearance departments, in order (the built-in four when
  // none are set up — e.g. the in-memory fallback).
  async function clearanceDepartments(): Promise<{ id: number | null; department: string; item_label: string; approver_user_id: number | null; sort_order: number }[]> {
    const rows: any[] = (await queryDB("SELECT * FROM exit_clearance_approvers").catch(() => [])) || [];
    if (!rows.length) return CLEARANCE_DEPARTMENTS.map((d, i) => ({ id: null, ...d, approver_user_id: null, sort_order: i + 1 }));
    return rows
      .map((r: any) => ({
        id: Number(r.id),
        department: String(r.department),
        item_label: r.item_label || CLEARANCE_DEPARTMENTS.find((d) => d.department === r.department)?.item_label || `${r.department} clearance`,
        approver_user_id: r.approver_user_id != null ? Number(r.approver_user_id) : null,
        sort_order: Number(r.sort_order) || 0
      }))
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  }

  async function canManageExits(userId: number, role: string): Promise<boolean> {
    if (role === "superadmin") return true;
    if (role !== "admin" && role !== "user") return false;
    const modules = await getAdminModules(userId);
    return modules.includes("exit_offboarding");
  }

  // Alerts: 'resignation' is the employee's own updates (opens My
  // Resignation), 'exit_clearance' a clearance item waiting on its
  // department approver (opens Approve Application), 'exit_offboarding' an
  // FYI to HR. Never throws — a failed alert mustn't fail the action.
  async function notify(userIds: (number | null | undefined)[], type: AlertType, title: string, message: string, exitId: number, exceptUserId?: number) {
    const seen = new Set<number>();
    for (const raw of userIds) {
      const uid = Number(raw);
      if (!uid || seen.has(uid) || uid === Number(exceptUserId)) continue;
      seen.add(uid);
      try {
        await createAlert(queryDB, { userId: uid, type, title, message, relatedType: "exit_request", relatedId: exitId });
      } catch (err: any) {
        console.warn("⚠️ Could not send exit/offboarding alert: " + err.message);
      }
    }
  }

  // HR side: every Superadmin plus anyone holding the 'exit_offboarding' module.
  async function hrUserIds(): Promise<number[]> {
    const users: any = await queryDB("SELECT id, role FROM users");
    const out: number[] = [];
    for (const u of users) {
      if (await canManageExits(Number(u.id), u.role)) out.push(Number(u.id));
    }
    return out;
  }

  const fmtDay = (v: any) => {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };

  // Tells each department approver whose clearance item is still open that
  // it's now in their Approve Application queue (only once HR has moved the
  // exit to 'clearance' — that's when the queue starts showing it).
  async function notifyClearanceApprovers(exitRow: any) {
    const items: any = await queryDB("SELECT * FROM exit_clearance_items");
    const users: any = await queryDB("SELECT id, name FROM users");
    const who = users.find((u: any) => Number(u.id) === Number(exitRow.user_id))?.name || "An employee";
    // What each department should collect, from the other modules.
    const dues = await collectExitDues(queryDB, Number(exitRow.user_id), await settlementOf(Number(exitRow.id))).catch(() => [] as ExitDue[]);
    const listOf = (kinds: ExitDue["kind"][]) => dues.filter((d) => kinds.includes(d.kind)).map((d) => d.label + (d.amount ? ` ৳${d.amount.toLocaleString("en-US")}` : ""));
    const forDept: Record<string, string[]> = { IT: listOf(["asset", "sim"]), Admin: listOf(["asset", "sim"]), Finance: listOf(["loan", "loan_request", "claim", "bill"]) };
    for (const it of items) {
      if (Number(it.exit_id) !== Number(exitRow.id) || Number(it.is_cleared) || it.approver_user_id == null) continue;
      const open = forDept[it.department] || [];
      await notify(
        [it.approver_user_id],
        "exit_clearance",
        `${it.department} Clearance Awaiting Your Approval`,
        `${who} is leaving${exitRow.last_working_day ? ` (last working day ${fmtDay(exitRow.last_working_day)})` : ""} — ${it.item_label}.${open.length ? ` On record: ${open.slice(0, 5).join("; ")}${open.length > 5 ? ` and ${open.length - 5} more` : ""}.` : ""} Review it in Approve Application.`,
        Number(exitRow.id)
      );
    }
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

  // Offboarding pending list (Exit / Offboarding -> Pending): every exit not
  // finished yet — still pending / in clearance, or settled with the Full &
  // Final not paid — with what each one is still waiting on: open clearance
  // items (and who they sit with), the settlement, the days to / past the
  // last working day, and — only with the "exit_dues" layer — the assets,
  // SIMs and loans still open in other modules. Plus the counts and the open
  // clearance items by department.
  app.get("/api/exit-requests/pending", authenticateToken, requireAdmin, requireModule("exit_offboarding"), async (req: any, res) => {
    try {
      const withDues = await hasModuleLayer(req.user, "exit_offboarding", "exit_dues");
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date());
      const dayDiff = (to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
      const ymd = (v: any) => {
        if (!v) return null;
        if (v instanceof Date) return isNaN(v.getTime()) ? null : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
        const s = String(v).slice(0, 10);
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
      };
      const [rows, emps]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM exit_requests"),
        queryDB("SELECT user_id, employee_id, department, designation FROM all_employees WHERE user_id IS NOT NULL")
      ]);
      const empOf = new Map<number, any>((emps || []).map((e: any) => [Number(e.user_id), e]));
      const list: any[] = [];
      for (const row of rows || []) {
        if (row.status === "cancelled") continue;
        const x = await serializeExit(row);
        const paid = x.settlement?.status === "paid";
        if (x.status === "settled" && paid) continue;
        const lwd = ymd(x.last_working_day);
        const days = lwd ? dayDiff(lwd) : null;
        const openItems = x.clearance_items.filter((c: any) => !c.is_cleared);
        const dues = withDues ? await collectExitDues(queryDB, x.user_id, await settlementOf(x.id)).catch(() => [] as ExitDue[]) : [];
        const blocking = dues.filter((d) => d.blocking);
        const emp = empOf.get(x.user_id);
        // Short "still waiting on" labels, in the order HR works them.
        const pending: { key: string; label: string; tone: "red" | "amber" | "slate" }[] = [];
        if (x.status === "pending") pending.push({ key: "review", label: "Not accepted yet — start clearance", tone: "amber" });
        for (const c of openItems) pending.push({ key: `clearance:${c.id}`, label: `${c.department} clearance${c.approver_name ? ` (${c.approver_name})` : " (unassigned)"}`, tone: days !== null && days < 0 ? "red" : "amber" });
        for (const d of blocking) pending.push({ key: d.key, label: d.kind === "loan" ? `${d.label} — ৳${(d.amount || 0).toLocaleString("en-US")} not in settlement` : `${d.kind === "sim" ? "SIM" : "Asset"}: ${d.label}`, tone: "red" });
        if (!x.settlement) pending.push({ key: "settlement", label: "Settlement not prepared", tone: "slate" });
        else if (!paid) pending.push({ key: "settlement", label: `Settlement ${x.settlement.status} — not paid`, tone: "slate" });
        list.push({
          id: x.id,
          user_id: x.user_id,
          name: x.user_name,
          employee_code: emp?.employee_id || null,
          department: emp?.department || null,
          designation: emp?.designation || null,
          exit_type: x.exit_type,
          status: x.status,
          notice_date: ymd(x.notice_date),
          last_working_day: lwd,
          days_left: days,
          clearance_total: x.clearance_items.length,
          clearance_done: x.clearance_items.length - openItems.length,
          open_clearance: openItems.map((c: any) => ({ id: c.id, department: c.department, item_label: c.item_label, approver_name: c.approver_name })),
          settlement_status: x.settlement?.status || null,
          net_payable: x.settlement ? x.settlement.net_payable : null,
          blocking_dues: blocking.map((d) => ({ key: d.key, kind: d.kind, label: d.label, amount: d.amount })),
          other_dues: dues.filter((d) => !d.blocking && !d.added).length,
          pending
        });
      }
      // Soonest last working day first; no date last.
      list.sort((a, b) => (a.days_left ?? 1e9) - (b.days_left ?? 1e9) || a.id - b.id);
      const byDept = new Map<string, { department: string; open: number; approvers: Set<string>; exits: { id: number; name: string }[] }>();
      for (const e of list) {
        for (const c of e.open_clearance) {
          const d = byDept.get(c.department) || { department: c.department, open: 0, approvers: new Set<string>(), exits: [] };
          d.open += 1;
          d.approvers.add(c.approver_name || "Unassigned");
          d.exits.push({ id: e.id, name: e.name });
          byDept.set(c.department, d);
        }
      }
      res.json({
        today,
        with_dues: withDues,
        summary: {
          open: list.length,
          not_accepted: list.filter((e) => e.status === "pending").length,
          leaving_7_days: list.filter((e) => e.days_left !== null && e.days_left >= 0 && e.days_left <= 7).length,
          past_last_day: list.filter((e) => e.days_left !== null && e.days_left < 0 && e.status !== "settled").length,
          clearance_open: list.reduce((t, e) => t + e.open_clearance.length, 0),
          settlement_unpaid: list.filter((e) => e.settlement_status !== "paid").length,
          blocking_dues: withDues ? list.reduce((t, e) => t + e.blocking_dues.length, 0) : null
        },
        by_department: [...byDept.values()].map((d) => ({ department: d.department, open: d.open, approvers: [...d.approvers], exits: d.exits })).sort((a, b) => b.open - a.open),
        exits: list
      });
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
      for (const item of await clearanceDepartments()) {
        await queryDB(
          "INSERT INTO exit_clearance_items (exit_id, department, item_label, approver_user_id) VALUES (?, ?, ?, ?)",
          [exitId, item.department, item.item_label, item.approver_user_id]
        );
      }
      const rows: any = await queryDB("SELECT * FROM exit_requests WHERE id = ?", [exitId]);
      if (exitType === "resignation" && targetUserId === Number(req.user.id)) {
        await notify(
          await hrUserIds(),
          "exit_offboarding",
          "New Resignation Submitted",
          `${req.user.name || "An employee"} submitted a resignation${lastWorkingDay ? ` — preferred last working day ${fmtDay(lastWorkingDay)}` : ""}.`,
          exitId,
          req.user.id
        );
      }
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
      const before: any = await queryDB("SELECT * FROM exit_requests WHERE id = ?", [id]);
      if (before.length === 0) return res.status(404).json({ error: "Exit request not found." });
      if (status === "settled" && before[0].status !== "settled") {
        const blocking = await settleBlockers(before[0]);
        // Settled follows the paid Full & Final (marking it Paid settles the exit).
        const paid = (await settlementOf(id))?.status === "paid";
        if (!paid)
          blocking.push({ key: "settlement", kind: "status", label: "Full & Final not paid", detail: "Mark the settlement Paid — that settles the exit.", amount: null, blocking: true, added: false });
        if (blocking.length) return res.status(409).json({ error: duesError(blocking), blocking });
      }
      await queryDB("UPDATE exit_requests SET status = ? WHERE id = ?", [status, id]);
      const rows: any = await queryDB("SELECT * FROM exit_requests WHERE id = ?", [id]);
      const exitRow = rows[0];
      // Settled = the person has left: their login is blocked (AccountBlock.ts).
      if (status === "settled" && before[0].status !== "settled") {
        await setAccountBlocked(queryDB, Number(exitRow.user_id), true, `${exitRow.exit_type === "termination" ? "Terminated" : "Resigned"} (exit settled)`, Number(req.user.id));
      }
      if (status !== before[0].status) {
        const lwd = fmtDay(exitRow.last_working_day);
        const msg: Record<string, [string, string]> = {
          clearance: ["Resignation Accepted — Clearance Started", `HR accepted your resignation${lwd ? `; last working day ${lwd}` : ""}. Each department will now clear you — follow it in My Resignation.`],
          cancelled: ["Resignation Cancelled", "Your resignation request was cancelled by HR."],
          settled: ["Resignation Settled", "Your exit is complete and your Full & Final Settlement is settled."],
          pending: ["Resignation Back Under Review", "Your resignation is back with HR for review."]
        };
        const [title, message] = msg[status];
        await notify([exitRow.user_id], "resignation", title, message, id, req.user.id);
        if (status === "clearance") await notifyClearanceApprovers(exitRow);
      }
      res.json(await serializeExit(exitRow));
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
      // A settled exit's clearance is final.
      const item: any = (await queryDB("SELECT exit_id FROM exit_clearance_items WHERE id = ?", [id]))[0];
      if (!item) return res.status(404).json({ error: "Clearance item not found." });
      const exitRow: any = (await queryDB("SELECT status FROM exit_requests WHERE id = ?", [Number(item.exit_id)]))[0];
      if (exitRow && (exitRow.status === "settled" || exitRow.status === "cancelled")) {
        return res.status(409).json({ error: `This exit is ${exitRow.status} — its clearance can't be changed.` });
      }
      await queryDB(
        "UPDATE exit_clearance_items SET is_cleared = ?, cleared_by = ?, cleared_at = ?, remarks = ? WHERE id = ?",
        [isCleared ? 1 : 0, isCleared ? req.user.id : null, isCleared ? new Date() : null, remarks, id]
      );
      const rows: any = await queryDB("SELECT * FROM exit_clearance_items WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Clearance item not found." });
      const r = rows[0];
      const who: any = r.approver_user_id != null ? (await queryDB("SELECT name FROM users WHERE id = ?", [Number(r.approver_user_id)]))[0] : null;
      res.json({
        id: Number(r.id),
        department: r.department,
        item_label: r.item_label,
        is_cleared: !!Number(r.is_cleared),
        remarks: r.remarks,
        approver_user_id: r.approver_user_id != null ? Number(r.approver_user_id) : null,
        approver_name: who?.name || null
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET: the clearance departments, in order, with what each clears and its
  // approver (Admin Panel -> Exit/
  // Offboarding -> Clearance Approvers settings) — module-gated, same as
  // every other management-side route here.
  app.get("/api/exit-clearance-approvers", authenticateToken, requireAdmin, requireModule("exit_offboarding"), async (req: any, res) => {
    try {
      const [rows, users]: [any, any] = await Promise.all([clearanceDepartments(), queryDB("SELECT id, name FROM users")]);
      const userById = new Map(users.map((u: any) => [Number(u.id), u]));
      res.json(
        rows.map((r: any) => ({
          id: r.id,
          department: r.department,
          item_label: r.item_label,
          sort_order: r.sort_order,
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

  // ---------- Clearance Departments (layer "exit_clearance_setup") ----------
  // Add / rename / reorder / remove the departments every NEW exit is cleared
  // by. Exits already raised keep the clearance items they were given (a
  // newly added department can be added to the open ones on request).
  const setupGate = [authenticateToken, requireAdmin, requireModule("exit_offboarding"), requireModuleLayer("exit_offboarding", "exit_clearance_setup")];
  const cleanDept = (body: any) => ({
    department: typeof body?.department === "string" ? body.department.trim().replace(/\s+/g, " ").slice(0, 100) : "",
    item_label: typeof body?.item_label === "string" ? body.item_label.trim().slice(0, 255) : ""
  });
  const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  app.post("/api/exit-clearance-departments", ...setupGate, async (req: any, res) => {
    try {
      const { department, item_label } = cleanDept(req.body);
      if (!department) return res.status(400).json({ error: "Write the department name." });
      if (!item_label) return res.status(400).json({ error: "Write what this department clears." });
      const list = await clearanceDepartments();
      if (list.some((d) => sameName(d.department, department))) return res.status(409).json({ error: `"${department}" is already in the list.` });
      const approver = req.body?.approver_user_id ? Number(req.body.approver_user_id) : null;
      const order = list.reduce((m, d) => Math.max(m, d.sort_order), 0) + 1;
      const r: any = await queryDB("INSERT INTO exit_clearance_approvers (department, approver_user_id, item_label, sort_order) VALUES (?, ?, ?, ?)", [
        department,
        approver,
        item_label,
        order
      ]);
      // Also onto the exits still open, when asked.
      let addedTo = 0;
      if (req.body?.apply_to_open) {
        const [exits, items]: [any, any] = await Promise.all([queryDB("SELECT * FROM exit_requests"), queryDB("SELECT exit_id, department FROM exit_clearance_items")]);
        for (const e of exits.filter((x: any) => x.status === "pending" || x.status === "clearance")) {
          if (items.some((i: any) => Number(i.exit_id) === Number(e.id) && sameName(String(i.department), department))) continue;
          await queryDB("INSERT INTO exit_clearance_items (exit_id, department, item_label, approver_user_id) VALUES (?, ?, ?, ?)", [Number(e.id), department, item_label, approver]);
          addedTo += 1;
          if (e.status === "clearance" && approver) {
            await notify([approver], "exit_clearance", `${department} Clearance Awaiting Your Approval`, `${item_label} — review it in Approve Application.`, Number(e.id));
          }
        }
      }
      res.status(201).json({ id: Number(r.insertId), department, item_label, sort_order: order, added_to_open: addedTo });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Rename a department / change what it clears. Exits already raised keep
  // the old wording.
  app.put("/api/exit-clearance-departments/:id", ...setupGate, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const list = await clearanceDepartments();
      const row = list.find((d) => d.id === id);
      if (!row) return res.status(404).json({ error: "Clearance department not found." });
      const next = cleanDept({ department: req.body?.department ?? row.department, item_label: req.body?.item_label ?? row.item_label });
      if (!next.department || !next.item_label) return res.status(400).json({ error: "Name and what it clears can't be empty." });
      if (list.some((d) => d.id !== id && sameName(d.department, next.department))) return res.status(409).json({ error: `"${next.department}" is already in the list.` });
      await queryDB("UPDATE exit_clearance_approvers SET department = ?, item_label = ? WHERE id = ?", [next.department, next.item_label, id]);
      res.json({ id, ...next });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // New order: ids top to bottom.
  app.put("/api/exit-clearance-departments-order", ...setupGate, async (req: any, res) => {
    try {
      const ids: number[] = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number);
      const list = await clearanceDepartments();
      if (ids.length !== list.length || !list.every((d) => d.id !== null && ids.includes(d.id))) return res.status(400).json({ error: "Send every department once." });
      for (const [i, id] of ids.entries()) await queryDB("UPDATE exit_clearance_approvers SET sort_order = ? WHERE id = ?", [i + 1, id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Remove a department from NEW exits (exits already raised keep its item).
  app.delete("/api/exit-clearance-departments/:id", ...setupGate, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const list = await clearanceDepartments();
      if (!list.some((d) => d.id === id)) return res.status(404).json({ error: "Clearance department not found." });
      if (list.length <= 1) return res.status(409).json({ error: "Keep at least one clearance department." });
      await queryDB("DELETE FROM exit_clearance_approvers WHERE id = ?", [id]);
      res.json({ success: true });
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
      const exitRows: any = await queryDB("SELECT * FROM exit_requests WHERE id = ?", [Number(item.exit_id)]);
      const exitRow = exitRows[0];
      if (exitRow) {
        await notify(
          [exitRow.user_id],
          "resignation",
          isCleared ? `${item.department} Clearance Done` : `${item.department} Clearance On Hold`,
          isCleared
            ? `${req.user.name || "The department"} cleared you: ${item.item_label}.${remarks ? ` Note: ${remarks}` : ""}`
            : `${req.user.name || "The department"} couldn't clear you yet: ${remarks || item.item_label}.`,
          Number(exitRow.id),
          req.user.id
        );
        const siblings: any = await queryDB("SELECT * FROM exit_clearance_items");
        const mine = siblings.filter((ci: any) => Number(ci.exit_id) === Number(exitRow.id));
        if (isCleared && mine.length > 0 && mine.every((ci: any) => !!Number(ci.is_cleared))) {
          const users: any = await queryDB("SELECT id, name FROM users");
          const who = users.find((u: any) => Number(u.id) === Number(exitRow.user_id))?.name || "The employee";
          await notify(await hrUserIds(), "exit_offboarding", "All Exit Clearances Done", `${who} is cleared by every department — ready for Full & Final Settlement.`, Number(exitRow.id), req.user.id);
        }
      }
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
  // ---------- Dues from other modules (layer "exit_dues") ----------

  // Whether this account sees the dues card (the page asks once).
  app.get("/api/exit-dues/access", authenticateToken, requireAdmin, requireModule("exit_offboarding"), async (req: any, res) => {
    try {
      res.json({
        exit_dues: await hasModuleLayer(req.user, "exit_offboarding", "exit_dues"),
        exit_pdf: await hasModuleLayer(req.user, "exit_offboarding", "exit_pdf"),
        exit_clearance_setup: await hasModuleLayer(req.user, "exit_offboarding", "exit_clearance_setup")
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  // ---------- Clearance Certificate / Settlement Sheet PDFs (layer "exit_pdf") ----------

  // Everything the two PDFs print, in one read: the person, the exit, who
  // cleared each department and when, and the settlement with its added dues.
  app.get("/api/exit-requests/:id/documents", ...pdfGate, async (req: any, res) => {
    try {
      const exitId = Number(req.params.id);
      const exitRows: any = await queryDB("SELECT * FROM exit_requests WHERE id = ?", [exitId]);
      if (exitRows.length === 0) return res.status(404).json({ error: "Exit request not found." });
      const ex = exitRows[0];
      const [users, emps, items, settlements]: [any, any, any, any] = await Promise.all([
        queryDB("SELECT id, name FROM users"),
        queryDB("SELECT * FROM all_employees"),
        queryDB("SELECT * FROM exit_clearance_items WHERE exit_id = ?", [exitId]),
        queryDB("SELECT * FROM final_settlements WHERE exit_id = ?", [exitId])
      ]);
      const nameOf = (id: any) => (id != null ? (users.find((u: any) => Number(u.id) === Number(id)) as any)?.name || null : null);
      const emp = emps.find((e: any) => Number(e.user_id) === Number(ex.user_id));
      const s = settlements[0];
      res.json({
        employee: {
          name: emp?.name || nameOf(ex.user_id),
          employee_code: emp?.employee_id || null,
          designation: emp?.designation || null,
          department: emp?.department || null,
          joining_date: emp?.joining_date || null
        },
        exit: {
          id: exitId,
          exit_type: ex.exit_type,
          reason: ex.reason,
          notice_date: ex.notice_date,
          last_working_day: ex.last_working_day,
          status: ex.status
        },
        clearance: items
          .sort((a: any, b: any) => Number(a.id) - Number(b.id))
          .map((it: any) => ({
            department: it.department,
            item_label: it.item_label,
            is_cleared: !!Number(it.is_cleared),
            cleared_by: nameOf(it.cleared_by),
            cleared_at: it.cleared_at,
            remarks: it.remarks
          })),
        settlement: s
          ? {
              unused_leave_days: Number(s.unused_leave_days),
              unused_leave_encashment: Number(s.unused_leave_encashment),
              gratuity_amount: Number(s.gratuity_amount),
              outstanding_dues: Number(s.outstanding_dues),
              other_additions: Number(s.other_additions),
              other_deductions: Number(s.other_deductions),
              net_payable: Number(s.net_payable),
              notes: s.notes,
              status: s.status,
              paid_at: s.paid_at,
              prepared_by: nameOf(s.prepared_by),
              added_dues: parseAddedDues(s.dues_json)
            }
          : null
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/exit-requests/:id/dues", ...duesGate, async (req: any, res) => {
    try {
      const exitId = Number(req.params.id);
      const exitRows: any = await queryDB("SELECT * FROM exit_requests WHERE id = ?", [exitId]);
      if (exitRows.length === 0) return res.status(404).json({ error: "Exit request not found." });
      const settlement = await settlementOf(exitId);
      const items = await collectExitDues(queryDB, Number(exitRows[0].user_id), settlement);
      res.json({ items, added: parseAddedDues(settlement?.dues_json), settlement_status: settlement?.status || null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Adds the chosen loan / advance balances to the settlement's outstanding
  // dues (once each) and recomputes the net payable.
  app.post("/api/exit-requests/:id/settlement/add-dues", ...duesGate, async (req: any, res) => {
    try {
      const exitId = Number(req.params.id);
      const keys: string[] = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : [];
      if (!keys.length) return res.status(400).json({ error: "Pick at least one balance to add." });
      const exitRows: any = await queryDB("SELECT * FROM exit_requests WHERE id = ?", [exitId]);
      if (exitRows.length === 0) return res.status(404).json({ error: "Exit request not found." });
      const settlement = await settlementOf(exitId);
      if (!settlement) return res.status(404).json({ error: "Open the Full & Final Settlement first to create its draft." });
      if (settlement.status === "paid") return res.status(409).json({ error: "This settlement is already paid." });
      const dues = await collectExitDues(queryDB, Number(exitRows[0].user_id), settlement);
      const picked = dues.filter((d) => d.kind === "loan" && keys.includes(d.key) && !d.added && d.amount);
      if (!picked.length) return res.status(409).json({ error: "Those balances are already in the settlement." });
      const list = parseAddedDues(settlement.dues_json);
      const now = new Date().toISOString();
      for (const d of picked) list.push({ key: d.key, label: d.label, amount: d.amount!, added_at: now, added_by: Number(req.user.id) });
      const outstanding = money(Number(settlement.outstanding_dues) + picked.reduce((t, d) => t + Number(d.amount), 0));
      const net = money(
        Number(settlement.unused_leave_encashment) + Number(settlement.gratuity_amount) + Number(settlement.other_additions) - outstanding - Number(settlement.other_deductions)
      );
      await queryDB("UPDATE final_settlements SET outstanding_dues = ?, net_payable = ?, dues_json = ? WHERE id = ?", [outstanding, net, JSON.stringify(list), Number(settlement.id)]);
      res.json({ success: true, added: picked.map((d) => d.key), outstanding_dues: outstanding, net_payable: net });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

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
      if (status === "paid" && settlement.status !== "paid") {
        const exitRows: any = await queryDB("SELECT * FROM exit_requests WHERE id = ?", [exitId]);
        const blocking = exitRows[0] ? await settleBlockers(exitRows[0]) : [];
        if (blocking.length) return res.status(409).json({ error: duesError(blocking), blocking });
      }

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
        // Settled = the person has left: their login is blocked (AccountBlock.ts).
        await setAccountBlocked(queryDB, Number(settlement.user_id), true, "Exit settled (final settlement paid)", Number(req.user.id));
      }
      if (status !== settlement.status && (status === "approved" || status === "paid")) {
        const amount = `৳${netPayable.toLocaleString("en-US")}`;
        await notify(
          [settlement.user_id],
          "resignation",
          status === "paid" ? "Final Settlement Paid" : "Final Settlement Approved",
          status === "paid"
            ? `Your Full & Final Settlement of ${amount} has been paid. Your exit is now complete.`
            : `Your Full & Final Settlement of ${amount} has been approved. See the breakdown in My Resignation.`,
          exitId,
          req.user.id
        );
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
