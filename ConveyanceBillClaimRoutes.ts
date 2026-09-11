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
    sourceType: string,
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
  // Valid Category values for a Conveyance Bill Claim — same
  // USER_CLAIM_CATEGORIES array defined once in server.ts.
  userClaimCategories: readonly string[];
}

export function registerConveyanceBillClaimRoutes(app: Express, deps: ConveyanceBillClaimRouteDeps) {
  const {
    authenticateToken,
    requireAdmin,
    requireModule,
    requireAnyModule,
    requireConveyanceClaimAccess,
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
    userClaimCategories: USER_CLAIM_CATEGORIES
  } = deps;

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
      res.json({
        ...bills[0],
        is_disbursed: !!Number(bills[0].is_disbursed),
        items: items.map((it: any) => ({ ...it, distance_km: it.distance_km !== null ? Number(it.distance_km) : null, rate_per_km: it.rate_per_km !== null ? Number(it.rate_per_km) : null, amount: Number(it.amount) }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/conveyance-bills", authenticateToken, requireAdmin, requireModule("conveyance"), async (req: any, res) => {
    try {
      const { user_id, bill_date, remarks } = req.body;
      if (!user_id) return res.status(400).json({ error: "Select a User for this bill." });
      const users = await queryDB("SELECT id FROM users WHERE id = ?", [user_id]);
      if (users.length === 0) return res.status(404).json({ error: "User not found" });
      const result = await queryDB(
        "INSERT INTO conveyance_bills (user_id, bill_date, remarks, created_by) VALUES (?, ?, ?, ?)",
        [user_id, bill_date || todayInDhaka(), remarks || null, req.user.id]
      );
      res.json({ success: true, id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to create bill" });
    }
  });

  app.put("/api/conveyance-bills/:id", authenticateToken, requireAdmin, requireModule("conveyance"), async (req, res) => {
    try {
      const { id } = req.params;
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
  app.delete("/api/conveyance-bills/:id", authenticateToken, requireAdmin, requireModule("conveyance"), async (req, res) => {
    try {
      const { id } = req.params;
      const bills = await queryDB("SELECT is_disbursed FROM conveyance_bills WHERE id = ?", [id]);
      if (bills.length === 0) return res.status(404).json({ error: "Bill not found" });
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
      const { id } = req.params;
      const bills = await queryDB(
        `SELECT b.*, u.name AS user_name FROM conveyance_bills b LEFT JOIN users u ON u.id = b.user_id WHERE b.id = ?`,
        [id]
      );
      if (bills.length === 0) return res.status(404).json({ error: "Bill not found" });
      const bill = bills[0];
      if (!!Number(bill.is_disbursed)) {
        return res.status(400).json({ error: "This Bill has already been disbursed." });
      }

      const itemCountRows = await queryDB("SELECT COUNT(*) AS cnt FROM conveyance_bill_items WHERE bill_id = ?", [id]);
      if (Number(itemCountRows[0]?.cnt || 0) === 0) {
        return res.status(400).json({ error: "This Bill has no line items yet — add at least one before disbursing." });
      }

      // Auto-suggested if the client didn't send one (or sent blank) — same
      // "PV-<billId>-<YYYYMMDD>" shape the frontend pre-fills, computed here too
      // so a bulk-disburse call (which sends no voucher_no per bill) still gets
      // one, and a single manual disburse can still override it.
      let voucher_no = typeof req.body?.voucher_no === "string" ? req.body.voucher_no.trim().slice(0, 100) : "";
      if (!voucher_no) {
        const today = todayInDhaka().replace(/-/g, "");
        voucher_no = `PV-${id}-${today}`;
      }

      await queryDB(
        "UPDATE conveyance_bills SET is_disbursed = 1, voucher_no = ?, disbursed_at = NOW(), disbursed_by = ? WHERE id = ?",
        [voucher_no, req.user.id, id]
      );

      try {
        const totalRows = await queryDB("SELECT COALESCE(SUM(amount), 0) AS total FROM conveyance_bill_items WHERE bill_id = ?", [id]);
        const total = Number(totalRows[0]?.total || 0);
        await createAlert(queryDB, {
          userId: bill.user_id,
          type: "conveyance_disbursed",
          title: "Conveyance Bill Disbursed",
          message: `Your conveyance bill CB-${id} of \u09f3${total.toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} has been disbursed (Voucher ${voucher_no}).`,
          relatedType: "conveyance_bill",
          relatedId: Number(id)
        });
      } catch (alertErr: any) {
        console.warn("⚠️ Could not notify the claimant for disbursed Bill #" + id + ": " + alertErr.message);
      }

      res.json({ success: true, voucher_no });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to disburse bill" });
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
      res.json(rows.map((r: any) => ({ ...r, distance_km: r.distance_km !== null ? Number(r.distance_km) : null })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Adds ONE line item to a Bill — either `source: "movement_claim"` (pulls
  // Particulars/Date/Distance straight from that Claim, computes Amount at the
  // given Rate/KM unless an explicit Amount override is sent) or
  // `source: "manual"` (every field typed in directly; Distance/Rate are optional
  // there since not every conveyance expense is KM-based).
  app.post("/api/conveyance-bills/:id/items", authenticateToken, requireAdmin, requireModule("conveyance"), async (req, res) => {
    try {
      const { id } = req.params;
      const bills = await queryDB("SELECT * FROM conveyance_bills WHERE id = ?", [id]);
      if (bills.length === 0) return res.status(404).json({ error: "Bill not found" });
      const bill = bills[0];
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

      // Manual entry — no source Movement Claim at all.
      const { entry_date, particulars, from_location, to_location, distance_km, rate_per_km, amount, remarks } = req.body;
      if (!entry_date || !particulars) {
        return res.status(400).json({ error: "Date and Particulars are required." });
      }
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

      const result = await queryDB(
        `INSERT INTO conveyance_bill_items
           (bill_id, source, claim_id, entry_date, particulars, from_location, to_location, distance_km, rate_per_km, amount, remarks)
         VALUES (?, 'manual', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, entry_date, particulars, from_location || null, to_location || null, distanceKm, rate, finalAmount, remarks || null]
      );
      res.json({ success: true, id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to add item" });
    }
  });

  app.put("/api/conveyance-bills/:billId/items/:itemId", authenticateToken, requireAdmin, requireModule("conveyance"), async (req, res) => {
    try {
      const { billId, itemId } = req.params;
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

  app.delete("/api/conveyance-bills/:billId/items/:itemId", authenticateToken, requireAdmin, requireModule("conveyance"), async (req, res) => {
    try {
      const { billId, itemId } = req.params;
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

  app.post("/api/user-claims", authenticateToken, requireConveyanceClaimAccess, async (req: any, res) => {
    try {
      const { claim_date, from_date, to_date, category, amount, description, file_base64, file_name, file_mimetype, claim_refs } =
        req.body || {};

      if (!claim_date) return res.status(400).json({ error: "Claim Date is required." });
      const from = from_date || claim_date;
      const to = to_date || claim_date;
      if (String(to) < String(from)) {
        return res.status(400).json({ error: "To Date can't be before From Date." });
      }
      if (!(USER_CLAIM_CATEGORIES as readonly string[]).includes(category)) {
        return res.status(400).json({ error: "Select a valid Category." });
      }

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

        const claimRows = await queryDB(`SELECT id, user_id, status FROM claims WHERE id IN (${refs.map(() => "?").join(",")})`, [
          ...refs.map((r) => r.claim_id)
        ]);
        for (const r of refs) {
          const claimRow = claimRows.find((c: any) => Number(c.id) === r.claim_id);
          if (!claimRow || Number(claimRow.user_id) !== Number(req.user.id)) {
            return res.status(400).json({ error: "One of the referenced check-in/outs doesn't belong to you." });
          }
          if (claimRow.status !== "completed") {
            return res.status(400).json({ error: "A referenced Movement Claim must be checked out first." });
          }
        }
        const alreadyUsed = await queryDB(
          `SELECT claim_id FROM user_claim_references WHERE claim_id IN (${refs.map(() => "?").join(",")})
           UNION
           SELECT claim_id FROM conveyance_bill_items WHERE claim_id IN (${refs.map(() => "?").join(",")})`,
          [...refs.map((r) => r.claim_id), ...refs.map((r) => r.claim_id)]
        );
        if (alreadyUsed.length > 0) {
          return res.status(409).json({ error: "One of the selected check-in/outs has already been referenced on another claim." });
        }
      }

      // When references are attached, the Claim Amount is always their sum — a
      // free-typed Amount is only used when there are none.
      const amt = refs.length > 0 ? refs.reduce((sum, r) => sum + r.amount, 0) : Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: "Claim Amount must be a positive number." });
      }
      const desc = typeof description === "string" ? description.trim().slice(0, 1000) : null;

      let fileBuffer: Buffer | null = null;
      if (file_base64 && typeof file_base64 === "string") {
        fileBuffer = Buffer.from(file_base64, "base64");
        if (fileBuffer.length > MAX_USER_CLAIM_FILE_BYTES) {
          return res.status(400).json({ error: "Attachment must be 5MB or smaller." });
        }
      }

      const result = await queryDB(
        `INSERT INTO user_claims
           (user_id, claim_date, from_date, to_date, category, amount, description, file_name, file_mimetype, file_data, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          req.user.id,
          claim_date,
          from,
          to,
          category,
          amt,
          desc,
          fileBuffer ? String(file_name || "attachment").slice(0, 255) : null,
          fileBuffer ? String(file_mimetype || "application/octet-stream") : null,
          fileBuffer
        ]
      );

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

      // Dynamic Approval Engine (Part 3) — Conveyance Bill Claims are routed
      // through this Employee's assigned Template for request_type
      // 'conveyance' (falling back to that request_type's default, and to a
      // straight auto-approve if neither exists). This REPLACES the old
      // global-chain routing this endpoint used before — see the long
      // comment above createTemplateApprovalRequest().
      const { autoApproved } = await createTemplateApprovalRequest("conveyance", "user_claim", result.insertId, req.user.id);
      if (autoApproved) {
        try {
          await finalizeUserClaimApproval(result.insertId, req.user.id, null, null);
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
                type: "conveyance_claim",
                title: "New Conveyance Bill Claim Awaiting Your Approval",
                message: `${req.user.name} submitted a ${category} claim of \u09f3${amt.toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${toDateOnlyString(claim_date)}). Please review it.`,
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
  });

  // The calling user's own submission history, most recent first — powers the
  // "My Conveyance Claims" list on the Conveyance Bill Claim card.
  app.get("/api/user-claims/mine", authenticateToken, requireConveyanceClaimAccess, async (req: any, res) => {
    try {
      const rows = await queryDB(
        `SELECT uc.id, uc.user_id, uc.claim_date, uc.from_date, uc.to_date, uc.category, uc.amount, uc.description,
                uc.file_name, uc.file_mimetype, (uc.file_data IS NOT NULL) AS has_file,
                uc.status, uc.admin_remarks, uc.reviewed_by, r.name AS reviewed_by_name, uc.reviewed_at,
                uc.created_at, uc.updated_at, i.id AS bill_item_id, i.bill_id
           FROM user_claims uc
           LEFT JOIN users r ON r.id = uc.reviewed_by
           LEFT JOIN conveyance_bill_items i ON i.user_claim_id = uc.id
          WHERE uc.user_id = ?
          ORDER BY uc.id DESC`,
        [req.user.id]
      );
      const withRefs = await attachUserClaimRefs(rows.map((r: any) => ({ ...r, amount: Number(r.amount), has_file: !!r.has_file })));
      const withApproval = await attachUserClaimApproval(withRefs);
      res.json(withApproval);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // System-wide list for the Admin Panel's Conveyance Bill Claim tab (source
  // "user_claim"), filterable by status/user — pending ones are what need review.
  app.get("/api/user-claims", authenticateToken, requireAdmin, requireModule("conveyance"), async (req, res) => {
    try {
      const rows = await queryDB(
        `SELECT uc.id, uc.user_id, u.name AS user_name, uc.claim_date, uc.from_date, uc.to_date, uc.category, uc.amount,
                uc.description, uc.file_name, uc.file_mimetype, (uc.file_data IS NOT NULL) AS has_file,
                uc.status, uc.admin_remarks, uc.reviewed_by, r.name AS reviewed_by_name, uc.reviewed_at,
                uc.created_at, uc.updated_at, i.id AS bill_item_id, i.bill_id
           FROM user_claims uc
           LEFT JOIN users u ON u.id = uc.user_id
           LEFT JOIN users r ON r.id = uc.reviewed_by
           LEFT JOIN conveyance_bill_items i ON i.user_claim_id = uc.id
          ORDER BY uc.id DESC`
      );
      const status = req.query.status ? String(req.query.status) : null;
      const user_id = req.query.user_id ? Number(req.query.user_id) : null;
      const filtered = rows.filter((r: any) => {
        if (status && r.status !== status) return false;
        if (user_id && Number(r.user_id) !== user_id) return false;
        return true;
      });
      const withRefs = await attachUserClaimRefs(
        filtered.map((r: any) => ({ ...r, amount: Number(r.amount), has_file: !!r.has_file }))
      );
      const withApproval = await attachUserClaimApproval(withRefs);
      res.json(withApproval);
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

      const { claim_date, from_date, to_date, category, amount, description } = req.body || {};
      if (!claim_date) return res.status(400).json({ error: "Claim Date is required." });
      const from = from_date || claim_date;
      const to = to_date || claim_date;
      if (String(to) < String(from)) {
        return res.status(400).json({ error: "To Date can't be before From Date." });
      }
      if (!(USER_CLAIM_CATEGORIES as readonly string[]).includes(category)) {
        return res.status(400).json({ error: "Select a valid Category." });
      }

      const refRows = await queryDB("SELECT amount FROM user_claim_references WHERE user_claim_id = ?", [uc.id]);
      let amt: number;
      if (refRows.length > 0) {
        // Referenced check-in/outs still drive the total — an Admin edits the
        // date/category/description here, not the Amount itself.
        amt = refRows.reduce((sum: number, r: any) => sum + Number(r.amount), 0);
      } else {
        amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0) {
          return res.status(400).json({ error: "Claim Amount must be a positive number." });
        }
      }
      const desc = typeof description === "string" ? description.trim().slice(0, 1000) : null;

      await queryDB(
        "UPDATE user_claims SET claim_date = ?, from_date = ?, to_date = ?, category = ?, amount = ?, description = ? WHERE id = ?",
        [claim_date, from, to, category, amt, desc, uc.id]
      );

      if (uc.status === "approved") {
        const itemRows = await queryDB("SELECT id FROM conveyance_bill_items WHERE user_claim_id = ?", [uc.id]);
        if (itemRows.length > 0) {
          const particulars = String(desc || `${category} claim`).slice(0, 255);
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

      if (isOwner) {
        if (uc.status !== "pending") return res.status(400).json({ error: "Only a Pending claim can be withdrawn." });
      } else if (!isAdmin) {
        return res.status(403).json({ error: "This claim doesn't belong to you." });
      }

      await queryDB("DELETE FROM conveyance_bill_items WHERE user_claim_id = ?", [req.params.id]);
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
