/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Conveyance Bill Claim (Admin Panel -> Conveyance, Conveyance Disbursement,
// and the User Panel's own "Conveyance Bill Claim" self-service card) routes,
// split out of server.ts on purpose — same convention as
// profileRoutes.ts/holidayRoutes.ts/Alerts.ts/UserManagement.ts: server.ts is
// already huge, so this module goes in its own file instead of growing it
// further. Registered from inside startServer() via
// registerConveyanceBillClaimRoutes(), reusing that same request's
// `app`/`authenticateToken`/`requireAdmin`/`requireModule`/`requireAnyModule`/
// `requireConveyanceClaimAccess`/`queryDB`/`createAlert`/`getAdminModules`/
// the Dynamic Approval Engine helpers/`toDateOnlyString`/`todayInDhaka`
// rather than creating a second Express app, a second DB connection, or a
// second copy of any of that shared logic.
//
// Extracted as-is from server.ts's "---- Conveyance Bill Claim (Superadmin +
// explicitly-granted Admins only) ----", "---- Conveyance Disbursement
// (Superadmin + explicitly-granted Admins only) ----" (kept alongside it —
// disbursement is one step downstream of the same conveyance_bills/
// conveyance_bill_items data model and its routes are interleaved with the
// Bill/Items routes below), and "---- Conveyance Bill Claim (User Panel —
// direct user-submitted claims) ----" sections — no logic changed, only
// moved. conveyance_bills/conveyance_bill_items table creation stays behind
// in server.ts's ensureSchemaMigrations(), same as every other table.

import type { Express } from "express";
import { checkClaimBills, loadCategories, attachClaimItems, loadPolicy, dateWindow, lockedDates, dhakaDate, claimFiledOn } from "./BillClaimPolicy";
import { claimEditState, claimRequests, recordClaimHistory, diffSnapshots, type ClaimEditMode } from "./ConveyanceClaimHistory";

interface ConveyanceBillClaimRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  // Same requireModule(moduleKey) factory used by every other Admin Panel
  // module in server.ts — pass "conveyance"/"disbursement" through it here so
  // a Superadmin can grant/revoke either module independently of every other
  // one.
  requireModule: (moduleKey: "conveyance" | "disbursement") => any;
  // Same as requireModule, but passes if the account has ANY of the given
  // modules — Conveyance Bill Claim and Conveyance Disbursement both need to
  // read conveyance_bills, without forcing an Admin who only has one of the
  // two to also be granted the other.
  requireAnyModule: (moduleKeys: ("conveyance" | "disbursement")[]) => any;
  // Conveyance Bill Claim self-service routes (User Panel) gate — a
  // Superadmin always passes; an Admin/User passes only once granted
  // can_view_conveyance_claims.
  requireConveyanceClaimAccess: any;
  // Conveyance -> "Claim on Behalf" layer (explicit-only, see
  // CONVEYANCE_LAYER_KEYS in server.ts).
  requireModuleLayer: (moduleKey: "conveyance", layer: "on_behalf") => any;
  hasModuleLayer: (user: any, moduleKey: "conveyance", layer: "on_behalf") => Promise<boolean>;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  createAlert: (queryDB: (sql: string, params?: any[]) => Promise<any>, alert: any) => Promise<any>;
  // Every account's Admin Panel module grants — used directly here (not just
  // through requireModule/requireAnyModule) wherever a route needs to tell an
  // owner apart from an Admin with the "conveyance" module.
  getAdminModules: (userId: number) => Promise<string[]>;
  // Dynamic Approval Engine (Part 3) — same helpers every other request_type
  // (leave/timesheet/attendance) routes through.
  createTemplateApprovalRequest: (
    requestType: "conveyance" | "leave" | "timesheet",
    sourceType: "user_claim",
    sourceId: number,
    employeeUserId: number
  ) => Promise<{ autoApproved: boolean; [key: string]: any }>;
  getCurrentStepApprovers: (request: any) => Promise<{ user_id: number; user_name: string | null }[]>;
  attachApprovalStatuses: (sourceType: "attendance" | "claim", rows: any[]) => Promise<any[]>;
  attachUserClaimApproval: (rows: any[]) => Promise<any[]>;
  finalizeUserClaimApproval: (
    userClaimId: number,
    approvedBy: number,
    billId: number | null,
    remarks: string | null
  ) => Promise<{ bill_id: number; bill_item_id: number }>;
  rejectUserClaimRecord: (userClaimId: number, rejectedBy: number, remarks: string | null) => Promise<void>;
  toDateOnlyString: (value: any) => string | null;
  todayInDhaka: () => string;
  // Department-wise scope for the 'conveyance' module (Admin Panel -> Users
  // -> Module Access -> "Conveyance Claim Departments") — same
  // getAttendanceReportDeptScope/getLeaveApplicationDeptScope convention
  // used by AttendanceRoutes.ts/LeaveRoutes.ts. Returns null for
  // unrestricted (every Department's claims visible); see the
  // conveyance_claim_department_access table comment in server.ts's
  // initDB() for the full design.
  getConveyanceClaimDeptScope: (userId: number) => Promise<string[] | null>;
}

// Marks a Bill paid out: voucher no + who/when, and tells the claimant. Used
// by Conveyance Disbursement and by a Conveyance Template's "Conveyance
// Disburser" Layer (server.ts performApprovalAction). Errors carry statusCode.
export async function disburseConveyanceBill(
  queryDB: (sql: string, params?: any[]) => Promise<any>,
  createAlert: (queryDB: (sql: string, params?: any[]) => Promise<any>, alert: any) => Promise<any>,
  todayInDhaka: () => string,
  id: number,
  userId: number,
  voucherNo?: unknown
): Promise<string> {
  const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
  const bills = await queryDB("SELECT * FROM conveyance_bills WHERE id = ?", [id]);
  if (bills.length === 0) throw fail(404, "Bill not found");
  const bill = bills[0];
  if (!!Number(bill.is_disbursed)) throw fail(400, "This Bill has already been disbursed.");
  // Nobody pays out their own bill — not even the Superadmin.
  if (Number(bill.user_id) === Number(userId)) throw fail(403, "You can't disburse a bill in your own name. Someone else has to pay it out.");

  const itemCountRows = await queryDB("SELECT COUNT(*) AS cnt FROM conveyance_bill_items WHERE bill_id = ?", [id]);
  if (Number(itemCountRows[0]?.cnt || 0) === 0) {
    throw fail(400, "This Bill has no line items yet — add at least one before disbursing.");
  }

  // Auto-suggested if the client didn't send one (or sent blank) — same
  // "PV-<billId>-<YYYYMMDD>" shape the frontend pre-fills, computed here too
  // so a bulk-disburse call (which sends no voucher_no per bill) still gets
  // one, and a single manual disburse can still override it.
  let voucher_no = typeof voucherNo === "string" ? voucherNo.trim().slice(0, 100) : "";
  if (!voucher_no) voucher_no = `PV-${id}-${todayInDhaka().replace(/-/g, "")}`;

  await queryDB("UPDATE conveyance_bills SET is_disbursed = 1, voucher_no = ?, disbursed_at = NOW(), disbursed_by = ? WHERE id = ?", [
    voucher_no,
    userId,
    id
  ]);

  try {
    const totalRows = await queryDB("SELECT COALESCE(SUM(amount), 0) AS total FROM conveyance_bill_items WHERE bill_id = ?", [id]);
    const total = Number(totalRows[0]?.total || 0);
    await createAlert(queryDB, {
      userId: bill.user_id,
      type: "conveyance_disbursed",
      title: "Conveyance Bill Disbursed",
      message: `Your conveyance bill CB-${id} of ৳${total.toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} has been disbursed (Voucher ${voucher_no}).`,
      relatedType: "conveyance_bill",
      relatedId: id
    });
  } catch (alertErr: any) {
    console.warn("⚠️ Could not notify the claimant for disbursed Bill #" + id + ": " + alertErr.message);
  }
  return voucher_no;
}

export function registerConveyanceBillClaimRoutes(app: Express, deps: ConveyanceBillClaimRouteDeps) {
  const {
    authenticateToken,
    requireAdmin,
    requireModule,
    requireAnyModule,
    requireConveyanceClaimAccess,
    requireModuleLayer,
    hasModuleLayer,
    queryDB,
    createAlert,
    getAdminModules,
    createTemplateApprovalRequest,
    getCurrentStepApprovers,
    attachApprovalStatuses,
    attachUserClaimApproval,
    finalizeUserClaimApproval,
    rejectUserClaimRecord,
    toDateOnlyString,
    todayInDhaka,
    getConveyanceClaimDeptScope
  } = deps;

  // Bills are made only from approved claims now (finalizeUserClaimApproval
  // in server.ts). What an Admin with the "conveyance" module may still do
  // to a bill, and what it may not:
  //   - nothing at all to a bill in their own name (Superadmin included),
  //   - nothing to a disbursed bill until the disbursement is undone,
  //   - lower an amount, never raise it (a Layer's approved amount is the cap),
  //   - add a check-in/out only once its approval is through.
  // Returns the bill, or sends the error and returns null.
  const loadBillForChange = async (id: any, req: any, res: any): Promise<any | null> => {
    const bills = await queryDB("SELECT * FROM conveyance_bills WHERE id = ?", [id]);
    if (bills.length === 0) {
      res.status(404).json({ error: "Bill not found" });
      return null;
    }
    const bill = bills[0];
    if (Number(bill.user_id) === Number(req.user.id)) {
      res.status(403).json({ error: "You can't change a bill in your own name." });
      return null;
    }
    if (!!Number(bill.is_disbursed)) {
      res.status(400).json({ error: "This Bill has been disbursed and is locked. Undo the disbursement first." });
      return null;
    }
    return bill;
  };

  // A check-in/out (Movement Claim) can go on a bill only once every approval
  // request on it (check-in and check-out) is approved; one with no approval
  // chain at all counts as approved.
  const movementClaimApproved = async (claimId: number): Promise<boolean> => {
    const reqs = await queryDB("SELECT status FROM approval_requests WHERE source_type = 'claim' AND source_id = ?", [claimId]);
    return reqs.every((r: any) => r.status === "approved");
  };

  // ---- Conveyance Bill Claim (Superadmin + explicitly-granted Admins only) ----
  // See the conveyance_bills/conveyance_bill_items table comments above for the
  // data model. Every route here is gated behind the "conveyance" Admin Panel
  // module — requireModule already lets a Superadmin through unconditionally and
  // otherwise checks admin_module_permissions, exactly like every other module.

  app.get("/api/conveyance-bills", authenticateToken, requireAdmin, requireAnyModule(["conveyance", "disbursement"]), async (req, res) => {
    try {
      const rows = await queryDB(
        `SELECT b.*, u.name AS user_name, du.name AS disbursed_by_name,
            (SELECT COUNT(*) FROM conveyance_bill_items i WHERE i.bill_id = b.id) AS item_count,
            (SELECT COALESCE(SUM(i.amount), 0) FROM conveyance_bill_items i WHERE i.bill_id = b.id) AS total_amount
         FROM conveyance_bills b
         LEFT JOIN users u ON u.id = b.user_id
         LEFT JOIN users du ON du.id = b.disbursed_by
         ORDER BY b.id DESC`
      );
      const user_id = req.query.user_id ? Number(req.query.user_id) : null;
      const from = req.query.from ? String(req.query.from) : null;
      const to = req.query.to ? String(req.query.to) : null;
      const filtered = rows.filter((r: any) => {
        if (user_id && Number(r.user_id) !== user_id) return false;
        const d = toDateOnlyString(r.bill_date);
        if (from && d && d < from) return false;
        if (to && d && d > to) return false;
        return true;
      });
      res.json(
        filtered.map((r: any) => ({
          ...r,
          is_disbursed: !!Number(r.is_disbursed),
          item_count: Number(r.item_count),
          total_amount: Number(r.total_amount)
        }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/conveyance-bills/:id", authenticateToken, requireAdmin, requireAnyModule(["conveyance", "disbursement"]), async (req, res) => {
    try {
      const { id } = req.params;
      const bills = await queryDB(
        `SELECT b.*, u.name AS user_name, du.name AS disbursed_by_name
         FROM conveyance_bills b
         LEFT JOIN users u ON u.id = b.user_id
         LEFT JOIN users du ON du.id = b.disbursed_by
         WHERE b.id = ?`,
        [id]
      );
      if (bills.length === 0) return res.status(404).json({ error: "Bill not found" });
      const items = await queryDB(`SELECT * FROM conveyance_bill_items WHERE bill_id = ? ORDER BY entry_date ASC, id ASC`, [id]);
      // The claimant's Employee record — the Payment Voucher prints their
      // code, designation and department.
      const emp: any[] = (await queryDB("SELECT employee_id, designation, department FROM all_employees WHERE user_id = ?", [bills[0].user_id])) || [];
      // An item that came from a Conveyance Bill Claim carries that claim's
      // category lines (user_claim_items: category, date, amount,
      // description) so the voucher can group the bill by category.
      const ucIds = items.map((it: any) => Number(it.user_claim_id)).filter((v: number) => v > 0);
      const [ucRows, ucItemRows]: any[] = ucIds.length
        ? await Promise.all([
            queryDB(`SELECT id, category FROM user_claims WHERE id IN (${ucIds.map(() => "?").join(",")})`, ucIds),
            queryDB(`SELECT * FROM user_claim_items WHERE user_claim_id IN (${ucIds.map(() => "?").join(",")}) ORDER BY bill_date, id`, ucIds)
          ])
        : [[], []];
      const ucCategory = new Map<number, string>((ucRows || []).map((r: any) => [Number(r.id), r.category]));
      res.json({
        ...bills[0],
        employee_code: emp[0]?.employee_id || null,
        designation: emp[0]?.designation || null,
        department: emp[0]?.department || null,
        is_disbursed: !!Number(bills[0].is_disbursed),
        items: items.map((it: any) => ({
          ...it,
          distance_km: it.distance_km !== null ? Number(it.distance_km) : null,
          rate_per_km: it.rate_per_km !== null ? Number(it.rate_per_km) : null,
          amount: Number(it.amount),
          claim_category: it.user_claim_id ? ucCategory.get(Number(it.user_claim_id)) || null : null,
          claim_lines: it.user_claim_id
            ? (ucItemRows || [])
                .filter((l: any) => Number(l.user_claim_id) === Number(it.user_claim_id))
                .map((l: any) => ({ category: l.category_name, bill_date: l.bill_date, amount: Number(l.amount), description: l.description || null }))
            : []
        }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // "New Bill" is gone: a bill is made only when a Conveyance Bill Claim is
  // approved through its chain. To claim for someone else, use
  // POST /api/user-claims/on-behalf/:userId (that claim gets approved like
  // any other). Kept as a clear refusal for older app versions.
  app.post("/api/conveyance-bills", authenticateToken, requireAdmin, requireModule("conveyance"), async (_req: any, res) => {
    res.status(410).json({
      error: "Bills can't be created by hand any more. File a Conveyance Bill Claim (Claim on Behalf) — the bill is made when it is approved."
    });
  });

  app.put("/api/conveyance-bills/:id", authenticateToken, requireAdmin, requireModule("conveyance"), async (req: any, res) => {
    try {
      const { id } = req.params;
      if (!(await loadBillForChange(id, req, res))) return;
      const { bill_date, remarks } = req.body;
      const result = await queryDB(
        "UPDATE conveyance_bills SET bill_date = COALESCE(?, bill_date), remarks = ? WHERE id = ?",
        [bill_date || null, remarks || null, id]
      );
      if (result.affectedRows === 0) return res.status(404).json({ error: "Bill not found" });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Deleting a Bill only removes the Bill + its line items (ON DELETE CASCADE) —
  // the underlying Movement Claim(s), if any were pulled in, are untouched and
  // become billable again in a future Bill. A Bill that's already been
  // disbursed (money actually paid out — see .../disburse below) can't be
  // deleted from here; it has to be undone first (POST .../undisburse), so a
  // paid-out Bill never just vanishes from the record without a trace.
  app.delete("/api/conveyance-bills/:id", authenticateToken, requireAdmin, requireModule("conveyance"), async (req: any, res) => {
    try {
      const { id } = req.params;
      const bills = await queryDB("SELECT is_disbursed, user_id FROM conveyance_bills WHERE id = ?", [id]);
      if (bills.length === 0) return res.status(404).json({ error: "Bill not found" });
      if (Number(bills[0].user_id) === Number(req.user.id)) {
        return res.status(403).json({ error: "You can't change a bill in your own name." });
      }
      if (!!Number(bills[0].is_disbursed)) {
        return res.status(400).json({ error: "This Bill has already been disbursed and can't be deleted. Undo the disbursement first." });
      }
      const result = await queryDB("DELETE FROM conveyance_bills WHERE id = ?", [id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: "Bill not found" });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Conveyance Disbursement (Superadmin + explicitly-granted Admins only) ----
  // One step downstream of Conveyance Bill Claim above: once a Bill's items have
  // been approved/finalized there, this is where the money actually going out
  // gets recorded — a Voucher No + who/when — so a Payment Voucher can be
  // printed for the claimant's signature. Kept behind its own "disbursement"
  // module (see ADMIN_MODULE_KEYS) so an Admin can be granted the power to BUILD
  // bills (the "conveyance" module above) without also being trusted to
  // authorize payouts, and vice versa.

  app.post("/api/conveyance-bills/:id/disburse", authenticateToken, requireAdmin, requireModule("disbursement"), async (req: any, res) => {
    try {
      const voucher_no = await disburseConveyanceBill(queryDB, createAlert, todayInDhaka, Number(req.params.id), req.user.id, req.body?.voucher_no);
      res.json({ success: true, voucher_no });
    } catch (err: any) {
      res.status(Number.isInteger(err?.statusCode) ? err.statusCode : 500).json({ error: err.message || "Failed to disburse bill" });
    }
  });

  // Marks a disbursed Bill back as Pending (mistaken entry, wrong voucher, needs
  // re-doing) — clears voucher_no/disbursed_at/disbursed_by so it reads as never
  // having been paid out, and can be re-disbursed (getting a fresh voucher_no)
  // once corrected.
  app.post("/api/conveyance-bills/:id/undisburse", authenticateToken, requireAdmin, requireModule("disbursement"), async (req, res) => {
    try {
      const { id } = req.params;
      const bills = await queryDB("SELECT is_disbursed FROM conveyance_bills WHERE id = ?", [id]);
      if (bills.length === 0) return res.status(404).json({ error: "Bill not found" });
      if (!Number(bills[0].is_disbursed)) {
        return res.status(400).json({ error: "This Bill isn't currently marked as disbursed." });
      }
      await queryDB(
        "UPDATE conveyance_bills SET is_disbursed = 0, voucher_no = NULL, disbursed_at = NULL, disbursed_by = NULL WHERE id = ?",
        [id]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to undo disbursement" });
    }
  });

  // Completed Movement Claims belonging to ONE User that haven't been pulled into
  // any Bill yet (a Claim can only ever be billed once — see the UNIQUE claim_id
  // constraint on conveyance_bill_items) — powers the "Add from Movement Claim"
  // picker inside a Bill.
  app.get("/api/conveyance-bills/available-claims/:userId", authenticateToken, requireAdmin, requireModule("conveyance"), async (req, res) => {
    try {
      const { userId } = req.params;
      const rows = await queryDB(
        `SELECT c.* FROM claims c
         WHERE c.user_id = ? AND c.status = 'completed'
           AND NOT EXISTS (SELECT 1 FROM conveyance_bill_items i WHERE i.claim_id = c.id)
         ORDER BY c.check_in_at DESC`,
        [userId]
      );
      const approved: any[] = [];
      for (const r of rows) if (await movementClaimApproved(Number(r.id))) approved.push(r);
      res.json(approved.map((r: any) => ({ ...r, distance_km: r.distance_km !== null ? Number(r.distance_km) : null })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Adds ONE line item to a Bill — either `source: "movement_claim"` (pulls
  // Particulars/Date/Distance straight from that Claim, computes Amount at the
  // given Rate/KM unless an explicit Amount override is sent) or
  // `source: "manual"` (every field typed in directly; Distance/Rate are optional
  // there since not every conveyance expense is KM-based).
  app.post("/api/conveyance-bills/:id/items", authenticateToken, requireAdmin, requireModule("conveyance"), async (req: any, res) => {
    try {
      const { id } = req.params;
      const bill = await loadBillForChange(id, req, res);
      if (!bill) return;
      const { source } = req.body;

      if (source === "movement_claim") {
        const { claim_id, rate_per_km, amount, remarks } = req.body;
        if (!claim_id) return res.status(400).json({ error: "Select a Movement Claim." });
        const claimRows = await queryDB("SELECT * FROM claims WHERE id = ?", [claim_id]);
        if (claimRows.length === 0) return res.status(404).json({ error: "Movement Claim not found" });
        const claim = claimRows[0];
        if (claim.status !== "completed") {
          return res.status(400).json({ error: "Only a completed Movement Claim (already checked out) can be billed." });
        }
        if (Number(claim.user_id) !== Number(bill.user_id)) {
          return res.status(400).json({ error: "That Movement Claim belongs to a different User than this Bill." });
        }
        const already = await queryDB("SELECT id FROM conveyance_bill_items WHERE claim_id = ?", [claim_id]);
        if (already.length > 0) return res.status(400).json({ error: "That Movement Claim has already been billed." });
        if (!(await movementClaimApproved(Number(claim_id)))) {
          return res.status(400).json({ error: "That check-in/out hasn't been approved yet — it can go on a bill once its approval is through." });
        }

        const distanceKm = claim.distance_km !== null && claim.distance_km !== undefined ? Number(claim.distance_km) : null;
        const rate = rate_per_km !== undefined && rate_per_km !== null && rate_per_km !== "" ? Number(rate_per_km) : null;
        let finalAmount: number;
        if (amount !== undefined && amount !== null && amount !== "") {
          finalAmount = Number(amount);
        } else if (distanceKm !== null && rate !== null) {
          finalAmount = Math.round(distanceKm * rate * 100) / 100;
        } else {
          return res.status(400).json({ error: "Enter a Rate per KM (or a fixed Amount) for this Claim." });
        }
        if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
          return res.status(400).json({ error: "Amount must be a positive number." });
        }

        const result = await queryDB(
          `INSERT INTO conveyance_bill_items
             (bill_id, source, claim_id, entry_date, particulars, from_location, to_location, distance_km, rate_per_km, amount, remarks)
           VALUES (?, 'movement_claim', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, claim_id, toDateOnlyString(claim.check_in_at), claim.purpose, null, null, distanceKm, rate, finalAmount, remarks || null]
        );
        return res.json({ success: true, id: result.insertId });
      }

      // Hand-typed lines are off: every amount on a bill comes from an
      // approved claim or an approved check-in/out.
      return res.status(403).json({ error: "Manual lines can't be added. File a Conveyance Bill Claim for it instead." });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to add item" });
    }
  });

  app.put("/api/conveyance-bills/:billId/items/:itemId", authenticateToken, requireAdmin, requireModule("conveyance"), async (req: any, res) => {
    try {
      const { billId, itemId } = req.params;
      if (!(await loadBillForChange(billId, req, res))) return;
      const items = await queryDB("SELECT * FROM conveyance_bill_items WHERE id = ? AND bill_id = ?", [itemId, billId]);
      if (items.length === 0) return res.status(404).json({ error: "Item not found" });
      const { entry_date, particulars, from_location, to_location, distance_km, rate_per_km, amount, remarks } = req.body;

      const distanceKm = distance_km !== undefined && distance_km !== null && distance_km !== "" ? Number(distance_km) : null;
      const rate = rate_per_km !== undefined && rate_per_km !== null && rate_per_km !== "" ? Number(rate_per_km) : null;
      let finalAmount: number;
      if (amount !== undefined && amount !== null && amount !== "") {
        finalAmount = Number(amount);
      } else if (distanceKm !== null && rate !== null) {
        finalAmount = Math.round(distanceKm * rate * 100) / 100;
      } else {
        return res.status(400).json({ error: "Enter an Amount (or both Distance and Rate per KM)." });
      }
      if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
        return res.status(400).json({ error: "Amount must be a positive number." });
      }
      // An amount on a bill was approved (or worked out from an approved
      // check-in/out): it may be lowered here, never raised.
      const currentAmount = Number(items[0].amount);
      if (finalAmount > currentAmount + 0.005) {
        return res.status(400).json({
          error: `The amount can only be lowered — it can't go above the approved ৳${currentAmount.toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`
        });
      }

      await queryDB(
        `UPDATE conveyance_bill_items SET
           entry_date = COALESCE(?, entry_date),
           particulars = COALESCE(?, particulars),
           from_location = ?, to_location = ?, distance_km = ?, rate_per_km = ?, amount = ?, remarks = ?
         WHERE id = ?`,
        [entry_date || null, particulars || null, from_location || null, to_location || null, distanceKm, rate, finalAmount, remarks || null, itemId]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/conveyance-bills/:billId/items/:itemId", authenticateToken, requireAdmin, requireModule("conveyance"), async (req: any, res) => {
    try {
      const { billId, itemId } = req.params;
      if (!(await loadBillForChange(billId, req, res))) return;
      const result = await queryDB("DELETE FROM conveyance_bill_items WHERE id = ? AND bill_id = ?", [itemId, billId]);
      if (result.affectedRows === 0) return res.status(404).json({ error: "Item not found" });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Conveyance Bill Claim (User Panel — direct user-submitted claims) ----
  // A User fills this in by hand (Claim Date, an optional From/To Date range for
  // multi-day tours, Category, Amount, optional Description/attachment) instead
  // of going through a live GPS check-in/out. Starts 'pending'; only the Admin
  // decision route below can move it to 'approved'/'rejected'. Mirrors the
  // FileReader/Base64 upload pattern already used for Budget Excel imports —
  // file_base64/file_name/file_mimetype in the JSON body, no multipart/multer.
  const MAX_USER_CLAIM_FILE_BYTES = 5 * 1024 * 1024; // 5MB, matches the client-side cap

  // Attaches a `claim_refs: [{ claim_id, amount, purpose, check_in_at,
  // check_out_at, distance_km }]` array onto each row (empty array when a claim
  // has none) — used by both /api/user-claims/mine and the Admin's
  // /api/user-claims list so the UI can show exactly which check-in/out(s) a
  // Conveyance Bill Claim's Amount was built from.
  async function attachUserClaimRefs(rows: any[]): Promise<any[]> {
    if (rows.length === 0) return rows;
    const ids = rows.map((r: any) => Number(r.id));
    const refRows = await queryDB(
      `SELECT r.user_claim_id, r.claim_id, r.amount, c.purpose, c.check_in_at, c.check_out_at, c.distance_km,
              c.check_in_lat, c.check_in_lng, c.check_out_lat, c.check_out_lng
         FROM user_claim_references r
         JOIN claims c ON c.id = r.claim_id
        WHERE r.user_claim_id IN (${ids.map(() => "?").join(",")})
        ORDER BY r.id ASC`,
      ids
    );
    // Same Approval Workflow status shown everywhere else a Movement Claim
    // appears (My Claims, Admin's Movement Claims tab) — reuses
    // attachApprovalStatuses by giving each row an `id` equal to its claim_id,
    // which is the join key that helper expects.
    const withApproval = await attachApprovalStatuses(
      "claim",
      refRows.map((rr: any) => ({ ...rr, id: rr.claim_id }))
    );
    const byClaim: Record<number, any[]> = {};
    for (const rr of withApproval) {
      const key = Number(rr.user_claim_id);
      if (!byClaim[key]) byClaim[key] = [];
      byClaim[key].push({
        claim_id: Number(rr.claim_id),
        amount: Number(rr.amount),
        purpose: rr.purpose,
        check_in_at: rr.check_in_at,
        check_out_at: rr.check_out_at,
        distance_km: rr.distance_km !== null ? Number(rr.distance_km) : null,
        check_in_lat: rr.check_in_lat !== null ? Number(rr.check_in_lat) : null,
        check_in_lng: rr.check_in_lng !== null ? Number(rr.check_in_lng) : null,
        check_out_lat: rr.check_out_lat !== null ? Number(rr.check_out_lat) : null,
        check_out_lng: rr.check_out_lng !== null ? Number(rr.check_out_lng) : null,
        check_in_approval: rr.check_in_approval,
        check_out_approval: rr.check_out_approval
      });
    }
    return rows.map((r: any) => ({ ...r, claim_refs: byClaim[Number(r.id)] || [] }));
  }

  // The save half of an edit (see submitUserClaim): the checks have passed;
  // rewrite the claim, its bills and check-in/out references, record the
  // change, and put it (back) in front of the right approver.
  async function saveClaimEdit(
    req: any,
    res: any,
    editing: any,
    mode: ClaimEditMode,
    request: any | null,
    checked: { lines: any[] },
    claimCategory: string,
    amt: number,
    desc: string | null,
    fileBuffer: Buffer | null,
    refs: { claim_id: number; amount: number }[],
    dates: { from: string; to: string },
    actor: { id: number; name: string }
  ) {
    const id = Number(editing.id);
    const { file_name, file_mimetype } = req.body || {};
    const fileSql = fileBuffer
      ? ", file_name = ?, file_mimetype = ?, file_data = ?"
      : req.body?.remove_file
        ? ", file_name = NULL, file_mimetype = NULL, file_data = NULL"
        : "";
    const fileParams = fileBuffer ? [String(file_name || "attachment").slice(0, 255), String(file_mimetype || "application/octet-stream"), fileBuffer] : [];
    await queryDB(
      `UPDATE user_claims SET from_date = ?, to_date = ?, category = ?, amount = ?, description = ?${fileSql},
              status = 'pending', approved_amount = NULL, edit_state = NULL, reclaim_allowed = 0, version = version + 1
              ${mode !== "pending" ? ", admin_remarks = NULL, reviewed_by = NULL, reviewed_at = NULL" : ""}
        WHERE id = ?`,
      [dates.from, dates.to, claimCategory, amt, desc, ...fileParams, id]
    );
    await queryDB("DELETE FROM user_claim_items WHERE user_claim_id = ?", [id]);
    for (const l of checked.lines) {
      await queryDB(
        "INSERT INTO user_claim_items (user_claim_id, category_id, category_name, bill_date, amount, description) VALUES (?, ?, ?, ?, ?, ?)",
        [id, l.category_id, l.category_name, l.bill_date, l.amount, l.description]
      );
    }
    const oldRefs: any[] = await queryDB("SELECT claim_id, amount FROM user_claim_references WHERE user_claim_id = ?", [id]);
    await queryDB("DELETE FROM user_claim_references WHERE user_claim_id = ?", [id]);
    try {
      for (const r of refs) {
        await queryDB("INSERT INTO user_claim_references (user_claim_id, claim_id, amount) VALUES (?, ?, ?)", [id, r.claim_id, r.amount]);
      }
    } catch {
      await queryDB("DELETE FROM user_claim_references WHERE user_claim_id = ?", [id]);
      for (const r of oldRefs) {
        await queryDB("INSERT INTO user_claim_references (user_claim_id, claim_id, amount) VALUES (?, ?, ?)", [id, r.claim_id, r.amount]).catch(() => {});
      }
      return res.status(409).json({ error: "One of the selected check-in/outs was just referenced elsewhere — please refresh and try again." });
    }
    await recordClaimHistory(queryDB, id, mode === "pending" ? "edited" : "resubmitted", actor, null);

    const claimantId = Number(editing.user_id);
    let current = request;
    if (!current) {
      // A claim with no approval request (filed before the chain existed, or
      // rejected through the legacy decision route) is routed now.
      if (mode !== "pending") {
        const { autoApproved } = await createTemplateApprovalRequest("conveyance", "user_claim", id, claimantId);
        if (autoApproved) {
          await finalizeUserClaimApproval(id, claimantId, null, null);
          return res.json({ success: true, id, auto_approved: true });
        }
        current = (await claimRequests(queryDB, [id])).get(id) || null;
      }
    } else if (mode !== "pending" || Number(current.current_step) > 1) {
      // After a Return / re-claim, or once past Layer 1: Layer 1 sees it again.
      let actions: any[] = [];
      try {
        actions = JSON.parse(current.actions_json || "[]");
      } catch {
        actions = [];
      }
      actions.push({
        step_order: Number(current.current_step),
        approver_id: actor.id,
        approver_name: actor.name,
        action: "resubmitted",
        remarks: null,
        acted_at: new Date().toISOString()
      });
      await queryDB("UPDATE approval_requests SET status = 'pending', current_step = 1, actions_json = ? WHERE id = ?", [JSON.stringify(actions), current.id]);
      current = { ...current, status: "pending", current_step: 1 };
    }
    if (current) {
      try {
        const approvers = await getCurrentStepApprovers(current);
        for (const approver of approvers) {
          await createAlert(queryDB, {
            userId: approver.user_id,
            type: "conveyance_approval",
            title: mode === "pending" ? "Conveyance Bill Claim Edited" : "Conveyance Bill Claim Resubmitted",
            message: `${actor.name} ${mode === "pending" ? "edited" : "resubmitted"} Conveyance Bill Claim #${id} (now \u09f3${amt.toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}). Please review the changes.`,
            relatedType: "user_claim",
            relatedId: id
          });
        }
      } catch (alertErr: any) {
        console.warn("⚠️ Could not notify the approver about edited Conveyance Bill Claim #" + id + ": " + alertErr.message);
      }
    }
    return res.json({ success: true, id });
  }

  // Files a Conveyance Bill Claim for `claimant` — the employee's own
  // (filedBy null) or one an Admin files for them (Claim on Behalf). Either
  // way it is checked against the claimant's Bill Claim Policy and goes
  // through the claimant's approval chain; nothing skips approval.
  //
  // `editing` (a user_claims row) re-saves that claim instead, with the same
  // checks: allowed only while claimEditState() says so (before the lock
  // Layer approves, after a Return, or after a Reject with re-claim allowed).
  // An edit after a Return/Reject — or once the request has moved past
  // Layer 1 — starts the chain again from Layer 1.
  async function submitUserClaim(
    req: any,
    res: any,
    claimant: { id: number; name: string },
    filedBy: { id: number; name: string } | null,
    editing: any | null = null,
    actor: { id: number; name: string } | null = null
  ) {
    try {
      const { claim_date, from_date, to_date, category, amount, description, file_base64, file_name, file_mimetype, claim_refs, items } =
        req.body || {};

      // A claim is filed today; its bills (items) carry their own dates.
      // Older app versions still send one Category + Amount instead of
      // items — that becomes a single bill dated From Date.
      const today = todayInDhaka();
      const policyNow = await loadPolicy(queryDB);
      let editMode: ClaimEditMode | null = null;
      let editRequest: any = null;
      if (editing) {
        editRequest = (await claimRequests(queryDB, [Number(editing.id)])).get(Number(editing.id)) || null;
        const st = claimEditState(editing, editRequest, policyNow);
        if (!st.editable) return res.status(400).json({ error: st.reason || "This claim can't be edited any more." });
        if (req.body?.version != null && Number(req.body.version) !== Number(editing.version)) {
          return res.status(409).json({ error: "This claim was changed in the meantime — reopen it and try again." });
        }
        editMode = st.mode;
      } else if (policyNow.one_claim_per_day) {
        // One new claim a day: more bills today go in today's claim.
        const todays = await claimFiledOn(queryDB, claimant.id, today);
        if (todays) {
          return res.status(400).json({
            error: `A claim was already filed today (#${todays}). One claim a day — edit that claim to add or change bills.`,
            today_claim_id: todays
          });
        }
      }
      const from = toDateOnlyString(from_date || claim_date || today) || today;
      const to = toDateOnlyString(to_date || from_date || claim_date || today) || from;
      if (String(to) < String(from)) {
        return res.status(400).json({ error: "To Date can't be before From Date." });
      }
      const usesItems = Array.isArray(items);

      // Optional Check In/Out references — each one is a completed Movement Claim
      // (claims table) the User owns, carrying its OWN Amount. A given check-in/
      // out can be referenced on at most one Conveyance Bill Claim ever, so every
      // id here must still show up in GET /api/claims/available at submit time.
      const refs: { claim_id: number; amount: number }[] = [];
      if (Array.isArray(claim_refs) && claim_refs.length > 0) {
        const seen = new Set<number>();
        for (const r of claim_refs) {
          const claimId = Number(r?.claim_id);
          const refAmount = Number(r?.amount);
          if (!Number.isFinite(claimId) || claimId <= 0) {
            return res.status(400).json({ error: "Invalid check-in/out reference." });
          }
          if (!Number.isFinite(refAmount) || refAmount <= 0) {
            return res.status(400).json({ error: "Each referenced check-in/out needs its own Amount greater than 0." });
          }
          if (seen.has(claimId)) {
            return res.status(400).json({ error: "The same check-in/out was selected twice." });
          }
          seen.add(claimId);
          refs.push({ claim_id: claimId, amount: refAmount });
        }

        const claimRows = await queryDB(
          `SELECT id, user_id, status, DATE_FORMAT(check_in_at, '%Y-%m-%d') AS check_in_day FROM claims WHERE id IN (${refs.map(() => "?").join(",")})`,
          [...refs.map((r) => r.claim_id)]
        );
        for (const r of refs) {
          const claimRow = claimRows.find((c: any) => Number(c.id) === r.claim_id);
          if (!claimRow || Number(claimRow.user_id) !== Number(claimant.id)) {
            return res.status(400).json({ error: "One of the referenced check-in/outs doesn't belong to this employee." });
          }
          if (claimRow.status !== "completed") {
            return res.status(400).json({ error: "A referenced Movement Claim must be checked out first." });
          }
          // Only check-ins inside the claim's own From–To range.
          const day = String(claimRow.check_in_day || "").slice(0, 10);
          if (usesItems && day && (day < String(from) || day > String(to))) {
            return res.status(400).json({ error: `A referenced check-in/out (${day}) is outside this claim's dates (${from} to ${to}).` });
          }
        }
        const alreadyUsed = await queryDB(
          `SELECT claim_id FROM user_claim_references WHERE claim_id IN (${refs.map(() => "?").join(",")}) AND user_claim_id <> ?
           UNION
           SELECT claim_id FROM conveyance_bill_items WHERE claim_id IN (${refs.map(() => "?").join(",")})`,
          [...refs.map((r) => r.claim_id), editing ? Number(editing.id) : 0, ...refs.map((r) => r.claim_id)]
        );
        if (alreadyUsed.length > 0) {
          return res.status(409).json({ error: "One of the selected check-in/outs has already been referenced on another claim." });
        }
      }

      const refsTotal = refs.reduce((sum, r) => sum + r.amount, 0);
      const desc = typeof description === "string" ? description.trim().slice(0, 1000) : null;

      let fileBuffer: Buffer | null = null;
      if (file_base64 && typeof file_base64 === "string") {
        fileBuffer = Buffer.from(file_base64, "base64");
        if (fileBuffer.length > MAX_USER_CLAIM_FILE_BYTES) {
          return res.status(400).json({ error: "Attachment must be 5MB or smaller." });
        }
      }
      // Editing: the attachment already on the claim stays unless replaced or
      // removed (remove_file).
      const keepOldFile = !!editing && !fileBuffer && !req.body?.remove_file && !!editing.file_data;

      // Bill Claim Policy (BillClaimPolicy.ts): dates, closed dates, limits,
      // categories, receipts. When references are attached and no bills, the
      // Claim Amount is their sum (older app versions).
      let lines = usesItems ? items : refs.length > 0 ? [] : [{ category, bill_date: from, amount, description: desc }];
      // With bills, check-in/out references belong to a Transport bill and
      // ARE its amount — the claim total counts them once, not on top of it.
      let extraTotal = refsTotal;
      if (usesItems && refs.length > 0) {
        const cats = await loadCategories(queryDB);
        const isTransport = (l: any) => {
          const c = cats.find((x) => x.id === Number(l?.category_id)) || (l?.category ? cats.find((x) => x.name.toLowerCase() === String(l.category).trim().toLowerCase()) : undefined);
          return !!c && /transport/i.test(c.name);
        };
        const at = lines.findIndex(isTransport);
        if (at < 0) {
          return res.status(400).json({ error: "Check-in/out references go with a Transport bill — choose Transport as a bill's category." });
        }
        lines = lines.map((l: any, i: number) => (i === at ? { ...l, amount: Math.round(refsTotal * 100) / 100 } : l));
        extraTotal = 0;
      }
      const checked = await checkClaimBills(queryDB, {
        userId: claimant.id,
        today,
        from,
        to,
        lines,
        extraTotal,
        hasAttachment: !!fileBuffer || keepOldFile,
        editingClaimId: editing ? Number(editing.id) : null,
        firstFiled: editing ? dhakaDate(editing.first_submitted_at || editing.created_at) : null
      });
      if ("error" in checked) return res.status(400).json({ error: checked.error });
      let claimCategory = checked.categorySummary;
      if (!claimCategory) {
        // References only: the category the older form sent, else "Check In/Out".
        const known = (await loadCategories(queryDB)).find((c) => c.is_active && c.name.toLowerCase() === String(category || "").toLowerCase());
        claimCategory = known ? known.name : "Check In/Out";
      }
      const amt = checked.total;
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: "Claim Amount must be a positive number." });
      }

      if (editing) {
        return await saveClaimEdit(req, res, editing, editMode!, editRequest, checked, claimCategory, amt, desc, fileBuffer, refs, { from, to }, actor || claimant);
      }
      const result = await queryDB(
        `INSERT INTO user_claims
           (user_id, claim_date, from_date, to_date, category, amount, description, file_name, file_mimetype, file_data, status, filed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [
          claimant.id,
          today,
          from,
          to,
          claimCategory,
          amt,
          desc,
          fileBuffer ? String(file_name || "attachment").slice(0, 255) : null,
          fileBuffer ? String(file_mimetype || "application/octet-stream") : null,
          fileBuffer,
          filedBy ? filedBy.id : null
        ]
      );

      try {
        for (const l of checked.lines) {
          await queryDB(
            "INSERT INTO user_claim_items (user_claim_id, category_id, category_name, bill_date, amount, description) VALUES (?, ?, ?, ?, ?, ?)",
            [result.insertId, l.category_id, l.category_name, l.bill_date, l.amount, l.description]
          );
        }
      } catch (itemErr: any) {
        await queryDB("DELETE FROM user_claims WHERE id = ?", [result.insertId]);
        throw itemErr;
      }

      if (refs.length > 0) {
        try {
          for (const r of refs) {
            await queryDB("INSERT INTO user_claim_references (user_claim_id, claim_id, amount) VALUES (?, ?, ?)", [
              result.insertId,
              r.claim_id,
              r.amount
            ]);
          }
        } catch (refErr: any) {
          // Someone else grabbed one of these check-in/outs in the split second
          // since we checked (UNIQUE claim_id) — undo the just-created claim
          // rather than leave a half-referenced row behind.
          await queryDB("DELETE FROM user_claims WHERE id = ?", [result.insertId]);
          return res
            .status(409)
            .json({ error: "One of the selected check-in/outs was just referenced elsewhere — please refresh and try again." });
        }
      }

      await queryDB("UPDATE user_claims SET first_submitted_at = NOW() WHERE id = ?", [result.insertId]);
      await recordClaimHistory(queryDB, result.insertId, "submitted", filedBy || claimant, null);

      // Dynamic Approval Engine (Part 3) — Conveyance Bill Claims are routed
      // through this Employee's assigned Template for request_type
      // 'conveyance' (falling back to that request_type's default, and to a
      // straight auto-approve if neither exists). This REPLACES the old
      // global-chain routing this endpoint used before — see the long
      // comment above createTemplateApprovalRequest().
      const { autoApproved } = await createTemplateApprovalRequest("conveyance", "user_claim", result.insertId, claimant.id);
      if (autoApproved) {
        try {
          await finalizeUserClaimApproval(result.insertId, claimant.id, null, null);
        } catch (finalizeErr: any) {
          console.warn("⚠️ Could not auto-process Conveyance Bill Claim #" + result.insertId + ": " + finalizeErr.message);
        }
      } else {
        // Notify whoever the request is actually sitting with first — same
        // idea as the Reliever alert on POST /api/leave-applications, just
        // without a dedicated pre-engine step to hang it off of here: fetch
        // the just-created approval_requests row and alert its current-step
        // approver(s) (Department/Direct Supervisor if that's step 1,
        // otherwise the Template's own first Layer). Best-effort — a missed
        // notification should never fail the submission itself.
        try {
          // Same query shape as attachUserClaimApproval (source_type = ?,
          // filtered by source_id in JS) so this also works against the
          // in-memory fallback DB's mock query matcher, not just real MySQL.
          const requestRows = await queryDB("SELECT * FROM approval_requests WHERE source_type = ?", ["user_claim"]);
          const createdRequest = requestRows.find((r: any) => Number(r.source_id) === Number(result.insertId));
          if (createdRequest) {
            const approvers = await getCurrentStepApprovers(createdRequest);
            for (const approver of approvers) {
              await createAlert(queryDB, {
                userId: approver.user_id,
                type: "conveyance_approval",
                title: "New Conveyance Bill Claim Awaiting Your Approval",
                message: `${filedBy ? `${filedBy.name} filed (for ${claimant.name})` : claimant.name} submitted a ${claimCategory} claim of \u09f3${amt.toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${today}). Please review it.`,
                relatedType: "user_claim",
                relatedId: result.insertId
              });
            }
          }
        } catch (alertErr: any) {
          console.warn("⚠️ Could not notify the current-step approver for Conveyance Bill Claim #" + result.insertId + ": " + alertErr.message);
        }
      }

      res.status(201).json({ success: true, id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to submit claim" });
    }
  }

  app.post("/api/user-claims", authenticateToken, requireConveyanceClaimAccess, async (req: any, res) => {
    await submitUserClaim(req, res, { id: Number(req.user.id), name: req.user.name }, null);
  });

  // Self-service Conveyance Bill Claim access (same rule as
  // requireConveyanceClaimAccess in server.ts), as a yes/no.
  const hasConveyanceClaimAccess = async (user: any): Promise<boolean> => {
    if (user.role === "superadmin") return true;
    const rows: any[] = await queryDB("SELECT can_view_conveyance_claims FROM users WHERE id = ?", [user.id]);
    if (rows.length > 0 && !!Number(rows[0].can_view_conveyance_claims)) return true;
    return (await getAdminModules(user.id)).includes("conveyance");
  };

  // Edit (or resubmit) a claim — the employee, or the Admin who filed it for
  // them with Claim on Behalf. Same body as POST /api/user-claims, plus
  // `version` (the one the form was opened with) and optional `remove_file`.
  app.post("/api/user-claims/:id/edit", authenticateToken, async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM user_claims WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Claim not found" });
      const uc = rows[0];
      const me = { id: Number(req.user.id), name: String(req.user.name || "") };
      if (Number(uc.user_id) === me.id) {
        if (!(await hasConveyanceClaimAccess(req.user))) {
          return res.status(403).json({ error: "You don't have access to Conveyance Bill Claim. Ask your Superadmin to grant it." });
        }
      } else if (!(Number(uc.filed_by) === me.id && (await hasModuleLayer(req.user, "conveyance", "on_behalf")))) {
        return res.status(403).json({ error: "Only the employee, or whoever filed it for them, can edit this claim." });
      }
      const owner: any[] = await queryDB("SELECT id, name FROM users WHERE id = ?", [uc.user_id]);
      await submitUserClaim(req, res, { id: Number(uc.user_id), name: String(owner[0]?.name || "") }, null, uc, me);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to save the claim" });
    }
  });

  // A claim's edit trail: submit / edit / return / reject / resubmit, who,
  // when, why, and what changed each time. Open to the employee, whoever filed
  // it for them, its approvers, and accounts with the Conveyance module.
  app.get("/api/user-claims/:id/history", authenticateToken, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const rows = await queryDB("SELECT id, user_id, filed_by FROM user_claims WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Claim not found" });
      const uc = rows[0];
      const me = Number(req.user.id);
      let allowed = req.user.role === "superadmin" || Number(uc.user_id) === me || Number(uc.filed_by) === me;
      if (!allowed) allowed = (await getAdminModules(me)).some((m) => m === "conveyance" || m === "approvals" || m === "disbursement");
      if (!allowed) {
        const request = (await claimRequests(queryDB, [id])).get(id);
        if (request) {
          let acted = false;
          try {
            acted = JSON.parse(request.actions_json || "[]").some((a: any) => Number(a.approver_id) === me);
          } catch {
            acted = false;
          }
          allowed = acted || (await getCurrentStepApprovers(request)).some((a) => Number(a.user_id) === me);
        }
      }
      if (!allowed) return res.status(403).json({ error: "You can't see this claim." });
      const hist: any[] = await queryDB(
        "SELECT id, action, actor_id, actor_name, reason, version, snapshot_json, created_at FROM user_claim_history WHERE user_claim_id = ? ORDER BY id",
        [id]
      );
      let prev: any = null;
      const out = hist.map((h: any) => {
        let snap: any = null;
        try {
          snap = JSON.parse(h.snapshot_json || "null");
        } catch {
          snap = null;
        }
        const changes = prev && snap && (h.action === "edited" || h.action === "resubmitted") ? diffSnapshots(prev, snap) : [];
        if (snap) prev = snap;
        return { id: h.id, action: h.action, actor_name: h.actor_name, reason: h.reason, version: h.version, created_at: h.created_at, changes, amount: snap?.amount ?? null };
      });
      res.json(out);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Conveyance -> Claim on Behalf. Finds the employee the claim is for; never
  // the filer themself (that is the normal self-service claim, and nobody —
  // the Superadmin included — makes a bill in their own name from here).
  const loadOnBehalfClaimant = async (req: any, res: any): Promise<{ id: number; name: string } | null> => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ error: "Select an employee." });
      return null;
    }
    if (userId === Number(req.user.id)) {
      res.status(403).json({ error: "You can't file a claim on behalf of yourself. Use your own Conveyance Bill Claim." });
      return null;
    }
    const rows = await queryDB("SELECT id, name FROM users WHERE id = ?", [userId]);
    if (rows.length === 0) {
      res.status(404).json({ error: "Employee not found." });
      return null;
    }
    return { id: Number(rows[0].id), name: String(rows[0].name) };
  };

  app.get("/api/user-claims/on-behalf/access", authenticateToken, requireAdmin, requireModule("conveyance"), async (req: any, res) => {
    res.json({ on_behalf: await hasModuleLayer(req.user, "conveyance", "on_behalf") });
  });

  // The employee's Bill Claim Policy (date window, categories, dates already
  // claimed) — what GET /api/bill-claim-policy/mine gives the employee.
  app.get(
    "/api/user-claims/on-behalf/:userId/policy",
    authenticateToken,
    requireAdmin,
    requireModule("conveyance"),
    requireModuleLayer("conveyance", "on_behalf"),
    async (req: any, res) => {
      try {
        const claimant = await loadOnBehalfClaimant(req, res);
        if (!claimant) return;
        const policy = await loadPolicy(queryDB);
        const today = todayInDhaka();
        // ?claim_id=: that employee's claim being edited (see /mine's twin).
        let editing: any = null;
        if (req.query.claim_id) {
          const rows: any[] = await queryDB("SELECT id, user_id, first_submitted_at, created_at FROM user_claims WHERE id = ?", [Number(req.query.claim_id)]);
          if (rows.length && Number(rows[0].user_id) === claimant.id) editing = rows[0];
        }
        const win = dateWindow(policy, today, editing ? dhakaDate(editing.first_submitted_at || editing.created_at) : null);
        res.json({
          today,
          min_date: win.min,
          max_date: win.max,
          values: policy,
          categories: (await loadCategories(queryDB)).filter((c) => c.is_active),
          locked_dates: await lockedDates(queryDB, claimant.id, today, win.min, win.max, policy, editing ? Number(editing.id) : null),
          today_claim_id: policy.one_claim_per_day && !editing ? await claimFiledOn(queryDB, claimant.id, today) : null
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  // The employee's own check-in/outs that can still be referenced — what
  // GET /api/claims/available gives the employee.
  app.get(
    "/api/user-claims/on-behalf/:userId/available-claims",
    authenticateToken,
    requireAdmin,
    requireModule("conveyance"),
    requireModuleLayer("conveyance", "on_behalf"),
    async (req: any, res) => {
      try {
        const claimant = await loadOnBehalfClaimant(req, res);
        if (!claimant) return;
        const rows = await queryDB(
          `SELECT c.* FROM claims c
            WHERE c.user_id = ? AND c.status = 'completed'
              AND NOT EXISTS (SELECT 1 FROM conveyance_bill_items i WHERE i.claim_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM user_claim_references r WHERE r.claim_id = c.id)
            ORDER BY c.check_in_at DESC`,
          [claimant.id]
        );
        res.json(rows.map((r: any) => ({ ...r, distance_km: r.distance_km !== null ? Number(r.distance_km) : null })));
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  app.post(
    "/api/user-claims/on-behalf/:userId",
    authenticateToken,
    requireAdmin,
    requireModule("conveyance"),
    requireModuleLayer("conveyance", "on_behalf"),
    async (req: any, res) => {
      try {
        const claimant = await loadOnBehalfClaimant(req, res);
        if (!claimant) return;
        await submitUserClaim(req, res, claimant, { id: Number(req.user.id), name: req.user.name });
      } catch (err: any) {
        res.status(500).json({ error: err.message || "Failed to submit claim" });
      }
    }
  );

  // Adds `editable` / `lock_reason` (claimEditState) to each claim row, so the
  // employee's list shows Edit only where the server would accept it.
  async function attachEditState(rows: any[]): Promise<any[]> {
    if (!rows.length) return rows;
    const policy = await loadPolicy(queryDB);
    const requests = await claimRequests(queryDB, rows.map((r: any) => Number(r.id)));
    return rows.map((r: any) => {
      const st = claimEditState(r, requests.get(Number(r.id)) || null, policy);
      return { ...r, reclaim_allowed: !!Number(r.reclaim_allowed), version: Number(r.version || 1), editable: st.editable, edit_mode: st.mode, lock_reason: st.reason };
    });
  }

  // The calling user's own submission history, most recent first — powers the
  // "My Conveyance Claims" list on the Conveyance Bill Claim card.
  app.get("/api/user-claims/mine", authenticateToken, requireConveyanceClaimAccess, async (req: any, res) => {
    try {
      const rows = await queryDB(
        `SELECT uc.id, uc.user_id, uc.claim_date, uc.from_date, uc.to_date, uc.category, uc.amount, uc.description,
                uc.file_name, uc.file_mimetype, (uc.file_data IS NOT NULL) AS has_file,
                uc.status, uc.admin_remarks, uc.reviewed_by, r.name AS reviewed_by_name, uc.reviewed_at,
                uc.created_at, uc.updated_at, i.id AS bill_item_id, i.bill_id, uc.filed_by, fb.name AS filed_by_name,
                uc.version, uc.edit_state, uc.return_reason, uc.reclaim_allowed, uc.first_submitted_at
           FROM user_claims uc
           LEFT JOIN users r ON r.id = uc.reviewed_by
           LEFT JOIN users fb ON fb.id = uc.filed_by
           LEFT JOIN conveyance_bill_items i ON i.user_claim_id = uc.id
          WHERE uc.user_id = ?
          ORDER BY uc.id DESC`,
        [req.user.id]
      );
      const withRefs = await attachUserClaimRefs(rows.map((r: any) => ({ ...r, amount: Number(r.amount), has_file: !!r.has_file })));
      const withApproval = await attachUserClaimApproval(withRefs);
      res.json(await attachEditState(await attachClaimItems(queryDB, withApproval)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // System-wide list for the Admin Panel's Conveyance Bill Claim tab (source
  // "user_claim"), filterable by status/user — pending ones are what need
  // review. Visibility is also narrowed by the 'conveyance' module's own
  // Department scope (Admin Panel -> Users -> Module Access -> "Conveyance
  // Claim Departments") — same convention GET /api/leave-applications/report
  // and GET /api/attendance/report/* use: a Superadmin, or an Admin/User
  // with no scope rows at all, sees every claim; a scoped account only ever
  // sees claims from accounts whose linked Employee Directory row has a
  // Department they've been granted. A claimant with no linked Employee row
  // (so no Department at all) is only ever visible to an unrestricted
  // viewer.
  app.get("/api/user-claims", authenticateToken, requireAdmin, requireModule("conveyance"), async (req: any, res) => {
    try {
      // ?since=YYYY-MM-DD: only claims dated on/after that day (the Admin
      // Dashboard's last three months).
      const since = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.since || "")) ? String(req.query.since) : null;
      const [rows, employees] = await Promise.all([
        queryDB(
          `SELECT uc.id, uc.user_id, u.name AS user_name, uc.claim_date, uc.from_date, uc.to_date, uc.category, uc.amount,
                  uc.description, uc.file_name, uc.file_mimetype, (uc.file_data IS NOT NULL) AS has_file,
                  uc.status, uc.admin_remarks, uc.reviewed_by, r.name AS reviewed_by_name, uc.reviewed_at,
                  uc.created_at, uc.updated_at, i.id AS bill_item_id, i.bill_id, uc.filed_by, fb.name AS filed_by_name,
                uc.version, uc.edit_state, uc.return_reason, uc.reclaim_allowed, uc.first_submitted_at
             FROM user_claims uc
             LEFT JOIN users u ON u.id = uc.user_id
             LEFT JOIN users r ON r.id = uc.reviewed_by
             LEFT JOIN users fb ON fb.id = uc.filed_by
             LEFT JOIN conveyance_bill_items i ON i.user_claim_id = uc.id
            ${since ? "WHERE uc.claim_date >= ?" : ""}
            ORDER BY uc.id DESC`,
          since ? [since] : []
        ),
        queryDB("SELECT user_id, department FROM all_employees WHERE user_id IS NOT NULL")
      ]);
      const departmentByUserId = new Map<number, string>();
      for (const e of employees) {
        if (e.user_id != null && e.department) departmentByUserId.set(Number(e.user_id), e.department);
      }

      const status = req.query.status ? String(req.query.status) : null;
      const user_id = req.query.user_id ? Number(req.query.user_id) : null;
      const deptScope = req.user.role === "superadmin" ? null : await getConveyanceClaimDeptScope(req.user.id);
      const filtered = rows.filter((r: any) => {
        if (status && r.status !== status) return false;
        if (user_id && Number(r.user_id) !== user_id) return false;
        if (deptScope) {
          const dept = departmentByUserId.get(Number(r.user_id)) || null;
          if (!dept || !deptScope.includes(dept)) return false;
        }
        return true;
      });
      const withRefs = await attachUserClaimRefs(
        filtered.map((r: any) => ({
          ...r,
          amount: Number(r.amount),
          has_file: !!r.has_file,
          department: departmentByUserId.get(Number(r.user_id)) || null
        }))
      );
      const withApproval = await attachUserClaimApproval(withRefs);
      res.json(await attachEditState(await attachClaimItems(queryDB, withApproval)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download/preview the attachment on a User Claim — the owner themself, or an
  // Admin with the "conveyance" module, may fetch it.
  app.get("/api/user-claims/:id/file", authenticateToken, async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM user_claims WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Claim not found" });
      const uc = rows[0];
      const isOwner = Number(uc.user_id) === Number(req.user.id);
      if (!isOwner) {
        if (req.user.role !== "superadmin") {
          if (req.user.role !== "admin" && req.user.role !== "user") return res.status(403).json({ error: "Not authorized" });
          const modules = await getAdminModules(req.user.id);
          if (!modules.includes("conveyance")) return res.status(403).json({ error: "Not authorized" });
        }
      }
      if (!uc.file_data) return res.status(404).json({ error: "No attachment on this claim" });
      const buffer: Buffer = Buffer.isBuffer(uc.file_data) ? uc.file_data : Buffer.from(uc.file_data);
      res.setHeader("Content-Type", uc.file_mimetype || "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(uc.file_name || `claim_${uc.id}`)}"`);
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin edit on a User Claim — corrects a typo'd Category/Amount/Description/
  // date range after the fact. When claim_refs are attached, Amount is always
  // re-derived from their sum (never taken from the request body) — the same
  // rule POST /api/user-claims enforces on submit. If the claim is already
  // Approved and attached to a Conveyance Bill line item, that item's
  // date/particulars/amount are updated too, so the issued Bill never drifts
  // out of sync with the claim it came from.
  app.put("/api/user-claims/:id", authenticateToken, requireAdmin, requireModule("conveyance"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM user_claims WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Claim not found" });
      const uc = rows[0];
      // Same lock as the employee's own edit: nothing once the lock Layer has
      // approved it, never one's own claim, and never a higher amount.
      if (Number(uc.user_id) === Number(req.user.id)) {
        return res.status(403).json({ error: "You can't change a claim in your own name." });
      }
      const ucState = claimEditState(uc, (await claimRequests(queryDB, [Number(uc.id)])).get(Number(uc.id)) || null, await loadPolicy(queryDB));
      if (!ucState.editable) return res.status(400).json({ error: ucState.reason || "This claim is locked." });

      const { claim_date, from_date, to_date, category, amount, description } = req.body || {};
      if (!claim_date) return res.status(400).json({ error: "Claim Date is required." });
      const from = from_date || claim_date;
      const to = to_date || claim_date;
      if (String(to) < String(from)) {
        return res.status(400).json({ error: "To Date can't be before From Date." });
      }
      // A claim with bill lines keeps its categories and total from those
      // lines; the Admin edits its dates and description here.
      const itemRows = await queryDB("SELECT amount, category_name FROM user_claim_items WHERE user_claim_id = ?", [uc.id]);
      const hasItems = itemRows.length > 0;
      const editCategory = hasItems ? uc.category : category;
      if (!hasItems && editCategory !== uc.category) {
        const known = (await loadCategories(queryDB)).some((c) => c.is_active && c.name === editCategory);
        if (!known) return res.status(400).json({ error: "Select a valid Category." });
      }

      const refRows = await queryDB("SELECT amount FROM user_claim_references WHERE user_claim_id = ?", [uc.id]);
      let amt: number;
      if (hasItems) {
        const refsSum = refRows.reduce((sum: number, r: any) => sum + Number(r.amount), 0);
        // Claims filed since references became the Transport bill's own
        // amount already carry them in that bill — count them once.
        const inTransportBill =
          refRows.length > 0 && itemRows.some((r: any) => /transport/i.test(String(r.category_name || "")) && Math.abs(Number(r.amount) - refsSum) < 0.005);
        amt = itemRows.reduce((sum: number, r: any) => sum + Number(r.amount), 0) + (inTransportBill ? 0 : refsSum);
      } else if (refRows.length > 0) {
        // Referenced check-in/outs still drive the total — an Admin edits the
        // date/category/description here, not the Amount itself.
        amt = refRows.reduce((sum: number, r: any) => sum + Number(r.amount), 0);
      } else {
        amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0) {
          return res.status(400).json({ error: "Claim Amount must be a positive number." });
        }
        if (amt > Number(uc.amount) + 0.005) {
          return res.status(400).json({ error: "The amount can only be lowered here, not raised." });
        }
      }
      const desc = typeof description === "string" ? description.trim().slice(0, 1000) : null;

      await queryDB(
        "UPDATE user_claims SET claim_date = ?, from_date = ?, to_date = ?, category = ?, amount = ?, description = ?, version = version + 1 WHERE id = ?",
        [claim_date, from, to, editCategory, amt, desc, uc.id]
      );
      await recordClaimHistory(queryDB, Number(uc.id), "edited", { id: Number(req.user.id), name: String(req.user.name || "") }, "Edited by an Admin");

      if (uc.status === "approved") {
        const itemRows = await queryDB("SELECT id FROM conveyance_bill_items WHERE user_claim_id = ?", [uc.id]);
        if (itemRows.length > 0) {
          const particulars = String(desc || `${editCategory} claim`).slice(0, 255);
          await queryDB("UPDATE conveyance_bill_items SET entry_date = ?, particulars = ?, amount = ? WHERE id = ?", [
            toDateOnlyString(claim_date),
            particulars,
            amt,
            itemRows[0].id
          ]);
        }
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to update claim" });
    }
  });

  // A User may withdraw their own claim while it's still Pending (mistaken entry,
  // duplicate, etc.) — once Approved/Rejected it's part of the review trail and
  // can no longer be removed from here. An Admin with the "conveyance" module may
  // instead delete ANY claim regardless of status (e.g. a duplicate or mistaken
  // submission an Admin spots during review) — if it was already Approved and
  // attached to a Conveyance Bill, that line item is removed too, so the Bill's
  // total never keeps a stale amount around for a claim that no longer exists.
  app.delete("/api/user-claims/:id", authenticateToken, async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM user_claims WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Claim not found" });
      const uc = rows[0];

      const isOwner = Number(uc.user_id) === Number(req.user.id);
      let isAdmin = false;
      if (!isOwner) {
        if (req.user.role === "superadmin") {
          isAdmin = true;
        } else if (req.user.role === "admin") {
          const modules = await getAdminModules(req.user.id);
          isAdmin = modules.includes("conveyance");
        }
      }

      const request = (await claimRequests(queryDB, [Number(uc.id)])).get(Number(uc.id)) || null;
      if (isOwner) {
        // Withdrawing is an edit too: only while the claim may still be edited.
        const st = claimEditState(uc, request, await loadPolicy(queryDB));
        if (!st.editable || uc.status === "rejected") {
          return res.status(400).json({ error: st.reason || "Only a claim that's still open for editing can be withdrawn." });
        }
      } else if (!isAdmin) {
        return res.status(403).json({ error: "This claim doesn't belong to you." });
      } else {
        // An Admin can't delete a claim whose bill has been paid out.
        const paid = await queryDB(
          "SELECT b.id FROM conveyance_bill_items i JOIN conveyance_bills b ON b.id = i.bill_id WHERE i.user_claim_id = ? AND b.is_disbursed = 1",
          [req.params.id]
        );
        if (paid.length > 0) return res.status(400).json({ error: "This claim's bill has been disbursed — undo the disbursement first." });
      }

      await queryDB("DELETE FROM conveyance_bill_items WHERE user_claim_id = ?", [req.params.id]);
      if (request) await queryDB("DELETE FROM approval_requests WHERE source_type = 'user_claim' AND source_id = ?", [req.params.id]);
      await queryDB("DELETE FROM user_claims WHERE id = ?", [req.params.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Legacy single-step Admin Approve/Reject on a Pending User Claim — only usable
  // when NO Approval Chain is configured (in that case POST /api/user-claims
  // already auto-processed the claim immediately, so this mostly exists for very
  // old rows created before this endpoint existed) OR as a Superadmin override for
  // a claim that somehow has no Approval Request tracking it. Once a chain exists,
  // new claims route through POST /api/approvals/:id/act instead — this route
  // refuses to touch a claim that already has an Approval Request in flight, so
  // the two paths can never double-process the same claim.
  app.post("/api/user-claims/:id/decision", authenticateToken, requireAdmin, requireModule("conveyance"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM user_claims WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Claim not found" });
      const uc = rows[0];
      if (uc.status !== "pending") return res.status(400).json({ error: "This claim has already been reviewed." });

      const existingRequest = await queryDB("SELECT id FROM approval_requests WHERE source_type = 'user_claim' AND source_id = ?", [uc.id]);
      if (existingRequest.length > 0) {
        return res.status(400).json({ error: "This claim is going through the Approval Workflow — act on it from the Approvals tab instead." });
      }

      const { action, remarks, bill_id } = req.body || {};
      const trimmedRemarks = typeof remarks === "string" ? remarks.trim().slice(0, 1000) : null;

      if (action === "reject") {
        if (!trimmedRemarks) return res.status(400).json({ error: "Please give a reason so the User understands why." });
        await rejectUserClaimRecord(uc.id, req.user.id, trimmedRemarks);
        return res.json({ success: true, status: "rejected" });
      }

      if (action !== "approve") return res.status(400).json({ error: "action must be 'approve' or 'reject'" });

      const targetBillId = bill_id ? Number(bill_id) : null;
      const result = await finalizeUserClaimApproval(uc.id, req.user.id, targetBillId, trimmedRemarks);
      res.json({ success: true, status: "approved", bill_id: result.bill_id, bill_item_id: result.bill_item_id });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to record the decision" });
    }
  });
}