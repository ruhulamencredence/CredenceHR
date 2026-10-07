/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Movement Claims (GPS check-in/out) routes, moved out of server.ts unchanged.
// The shared helpers they use are passed in by startServer().

import type { Express } from "express";

export interface RegisterMovementClaimRoutesDeps {
  authenticateToken: any;
  haversineMeters: any;
  queryDB: any;
  requireAdmin: any;
  requireModule: any;
  requireMovementClaimAccess: any;
  toDateOnlyString: any;
}

export function registerMovementClaimRoutes(app: Express, deps: RegisterMovementClaimRoutesDeps) {
  const { authenticateToken, haversineMeters, queryDB, requireAdmin, requireModule, requireMovementClaimAccess, toDateOnlyString } = deps;
  // 2c. Movement Claims — a free-form (no fixed Project geofence) point A -> point
  // B travel check-in/check-out: a User checks in with a Purpose (why/where
  // they're heading out for office work), then later checks out once they reach
  // or finish there. Used for TA/DA-style reimbursement review in the Admin
  // Panel's Movement Claims tab (gated per-Admin like every other module — a
  // Superadmin always sees it). Only ONE claim per User may be 'open' at a time.
  function parseClaimCoords(body: any): { lat: number; lng: number; remarks: string | null } | { error: string } {
    const lat = Number(body.latitude);
    const lng = Number(body.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { error: "Couldn't read your current location. Please allow location access and try again." };
    }
    const remarks = typeof body.remarks === "string" ? body.remarks.trim().slice(0, 1000) || null : null;
    return { lat, lng, remarks };
  }

  app.post("/api/claims/check-in", authenticateToken, requireMovementClaimAccess, async (req: any, res) => {
    try {
      const purpose = typeof req.body?.purpose === "string" ? req.body.purpose.trim().slice(0, 255) : "";
      if (!purpose) return res.status(400).json({ error: "Please describe where/why you're going." });
      const parsed = parseClaimCoords(req.body || {});
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      const { lat, lng, remarks } = parsed;

      const openExisting = await queryDB("SELECT * FROM claims WHERE user_id = ? AND status = 'open'", [req.user.id]);
      if (openExisting.length > 0) {
        return res.status(400).json({ error: "You already have an open claim — check out of it before starting a new one." });
      }

      const result = await queryDB(
        "INSERT INTO claims (user_id, purpose, status, check_in_at, check_in_lat, check_in_lng, check_in_remarks) VALUES (?, ?, 'open', NOW(), ?, ?, ?)",
        [req.user.id, purpose, lat, lng, remarks]
      );
      // Movement Claims are never routed through the Approval Chain — a User's
      // Check In/Out here needs no Admin/Approver sign-off (unlike Remote
      // Attendance above, which still does). See attachApprovalStatuses: with no
      // approval_requests row ever created for source_type 'claim', it always
      // resolves check_in_approval/check_out_approval to null, and ApprovalBadge
      // already renders nothing for a null approval — no UI change needed there.
      res.status(201).json({ success: true, id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/claims/:id/check-out", authenticateToken, requireMovementClaimAccess, async (req: any, res) => {
    try {
      const { id } = req.params;
      const parsed = parseClaimCoords(req.body || {});
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      const { lat, lng, remarks } = parsed;

      const rows = await queryDB("SELECT * FROM claims WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Claim not found." });
      const claim = rows[0];
      if (Number(claim.user_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: "This claim doesn't belong to you." });
      }
      if (claim.status !== "open") {
        return res.status(400).json({ error: "This claim has already been checked out." });
      }

      const distanceKm = Number(
        (haversineMeters(Number(claim.check_in_lat), Number(claim.check_in_lng), lat, lng) / 1000).toFixed(2)
      );

      await queryDB(
        "UPDATE claims SET status = 'completed', check_out_at = NOW(), check_out_lat = ?, check_out_lng = ?, check_out_remarks = ?, distance_km = ? WHERE id = ?",
        [lat, lng, remarks, distanceKm, id]
      );
      // No Approval Chain for Movement Claims — see the matching note on check-in above.
      res.json({ success: true, distance_km: distanceKm });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The calling user's own currently-open claim (if any) — lets the User Panel
  // show the right Check In / Check Out button state on load/refresh.
  app.get("/api/claims/status", authenticateToken, requireMovementClaimAccess, async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM claims WHERE user_id = ? AND status = 'open'", [req.user.id]);
      res.json(rows[0] || null);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The calling user's own claim history, most recent first.
  app.get("/api/claims/mine", authenticateToken, requireMovementClaimAccess, async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM claims WHERE user_id = ? ORDER BY id DESC", [req.user.id]);
      res.json(rows.slice(0, 200));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The calling user's own completed Movement Claims that haven't been referenced
  // by a Conveyance Bill Claim yet (user_claim_references) and haven't already
  // been pulled directly into an official Bill by an Admin either
  // (conveyance_bill_items.claim_id) — powers the "Reference Check In/Out" picker
  // in the New Conveyance Claim form. Each check-in/out can only ever be
  // referenced/billed ONCE.
  app.get("/api/claims/available", authenticateToken, requireMovementClaimAccess, async (req: any, res) => {
    try {
      const rows = await queryDB(
        `SELECT c.* FROM claims c
          WHERE c.user_id = ? AND c.status = 'completed'
            AND NOT EXISTS (SELECT 1 FROM conveyance_bill_items i WHERE i.claim_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM user_claim_references r WHERE r.claim_id = c.id)
          ORDER BY c.check_in_at DESC`,
        [req.user.id]
      );
      res.json(rows.map((r: any) => ({ ...r, distance_km: r.distance_km !== null ? Number(r.distance_km) : null })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // System-wide claim list for the Superadmin's (or a granted Admin's) Movement
  // Claims tab — every User's check-ins/outs, filterable by user/date, for
  // TA/DA-style reimbursement review.
  app.get("/api/claims", authenticateToken, requireAdmin, requireModule("claims"), async (req: any, res) => {
    try {
      const rows = await queryDB(
        "SELECT c.*, u.name AS user_name FROM claims c LEFT JOIN users u ON u.id = c.user_id ORDER BY c.id DESC"
      );
      const user_id = req.query.user_id ? Number(req.query.user_id) : null;
      const from = req.query.from ? String(req.query.from) : null;
      const to = req.query.to ? String(req.query.to) : null;
      const status = req.query.status ? String(req.query.status) : null;

      const filtered = rows.filter((r: any) => {
        if (user_id && Number(r.user_id) !== user_id) return false;
        if (status && r.status !== status) return false;
        const dateOnly = toDateOnlyString(r.check_in_at);
        if (from && dateOnly && dateOnly < from) return false;
        if (to && dateOnly && dateOnly > to) return false;
        return true;
      });

      const withApprovals = filtered.slice(0, 1000);
      res.json(withApprovals);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin cleanup — remove a mistaken/duplicate claim entirely (not a soft delete,
  // since a claim carries no downstream data the way an MPR Entry does).
  app.delete("/api/claims/:id", authenticateToken, requireAdmin, requireModule("claims"), async (req, res) => {
    try {
      const { id } = req.params;
      const result = await queryDB("DELETE FROM claims WHERE id = ?", [id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: "Claim not found" });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
