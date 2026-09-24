/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Vehicle Requisition & Management (Self Service -> "Book a Ride" / "Ride
// Status", plus Admin Panel -> Vehicle Management) — kept in its own file,
// same reasoning as AssetManagementRoutes.ts/GrievanceRoutes.ts: server.ts is
// already huge, so new features go in their own module and are registered
// from inside startServer() via registerVehicleManagementRoutes(), reusing
// that request's authenticateToken/requireAdmin/requireModule/queryDB.
//
// Follows the flowchart (যানবাহন রিকুইজিশন ওয়ার্কফ্লো v1.0):
//   লগইন -> Book a Ride -> রিকুইজিশন ফর্ম পূরণ -> সাবমিট -> HR/Admin রিভিউ
//   (গাড়ির অ্যাভেইলেবিলিটি চেক) -> Approved: গাড়ি ও ড্রাইভার অ্যাসাইনমেন্ট,
//   ইউজারকে কনফার্মেশন -> রাইড সম্পন্ন ও গাড়ি ফেরত -> নির্ধারিত সময়ে ফেরত
//   এসেছে? হ্যাঁ -> রাইড ক্লোজড (End). না (Late) -> ইউজার পূর্বে সিস্টেমে
//   ইনফর্ম করেছে? হ্যাঁ -> টাইম এক্সটেনশন রিকোয়েস্ট HR/Admin অনুমোদন করবে ->
//   End. না -> HR ম্যানুয়ালি এন্ট্রি ও নোটিশ ফ্ল্যাগ প্রদান করবে -> End.
//
// The "HR/Admin রিভিউ" diamond routes through the SAME Dynamic Approval
// Engine every other module uses (request_type 'vehicle', source_type
// 'vehicle_requisition' — see createTemplateApprovalRequest/
// performApprovalAction/finalizeVehicleRequisitionApproval in server.ts): a
// Superadmin builds a Template for it from Admin Panel -> Approvals ->
// Templates (Layer 1 is named "HR/Admin Review" — see LAYER_NAMES in
// ApprovalTemplateManager.tsx — with its Approver Type set to Employee/Admin
// and specific people picked, since this flowchart has no separate
// Supervisor step to default Layer 1 to). Approve/Reject itself therefore
// happens from Admin Panel -> Approvals / "My Approvals" like every other
// module, NOT from a route in this file. Once the Approval Workflow
// approves, the requisition flips to 'approved' (workflow cleared) — IT/
// Admin then still has to do the flowchart's own "গাড়ি ও ড্রাইভার
// অ্যাসাইনমেন্ট" step via PUT /api/vehicles/requisitions/:id/assign below
// (status 'approved' -> 'ongoing'), same two-step shape as Asset
// Requisition's own POST /api/assets/requisitions/:id/fulfill.
//
// Same convention as GrievanceRoutes.ts/ExitOffboardingRoutes.ts otherwise:
// every write route only ever does `WHERE id = ?`, filtering/joins happen in
// JS after a full-table SELECT, and every INSERT/UPDATE is all-`?`-
// placeholders so the in-memory dev fallback's generic positional simulator
// (see simulateGenericTable in memoryDbFallback.ts) stays correct with zero
// bespoke handlers needed.

import type { Express } from "express";
import type { AlertType } from "./Alerts";

interface VehicleManagementRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: "vehicle_management") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  getAdminModules: (userId: number) => Promise<string[]>;
  createAlert: (
    queryDB: (sql: string, params?: any[]) => Promise<any>,
    params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }
  ) => Promise<void>;
  // Dynamic Approval Engine (server.ts) — routes a submitted requisition
  // through request_type 'vehicle' the same way Asset Requisition does. See
  // the design note above registerVehicleManagementRoutes.
  createTemplateApprovalRequest: (
    requestType: "conveyance" | "leave" | "timesheet" | "asset" | "vehicle",
    sourceType: "user_claim" | "attendance_correction" | "leave_application" | "asset_requisition" | "vehicle_requisition",
    sourceId: number,
    requestedBy: number,
    overrideSupervisorId?: number | null
  ) => Promise<{ autoApproved: boolean; template: any | null }>;
  getCurrentStepApprovers: (request: any) => Promise<{ user_id: number; user_name: string | null }[]>;
  // Auto-approve path (no Template resolved at all for this employee/type) —
  // same finalize function performApprovalAction's 'vehicle_requisition'
  // branch calls once the Approval Workflow's LAST step signs off.
  finalizeVehicleRequisitionApproval: (requisitionId: number, approvedBy: number, remarks: string | null) => Promise<void>;
}

export async function ensureVehicleManagementSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS vehicles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vehicle_no VARCHAR(50) NOT NULL UNIQUE,
        model VARCHAR(150) NOT NULL,
        vehicle_type VARCHAR(50) NULL,
        status ENUM('available','on_ride','maintenance') NOT NULL DEFAULT 'available',
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure vehicles table exists: " + err.message);
  }
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS vehicle_requisitions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_user_id INT NOT NULL,
        purpose TEXT NOT NULL,
        pickup_location VARCHAR(255) NOT NULL,
        destination VARCHAR(255) NOT NULL,
        ride_date DATE NOT NULL,
        start_time VARCHAR(10) NOT NULL,
        estimated_duration_hours DECIMAL(5,2) NOT NULL,
        expected_return_at DATETIME NULL,
        status ENUM('pending','approved','ongoing','rejected','cancelled','completed') NOT NULL DEFAULT 'pending',
        decided_by INT NULL,
        decided_at TIMESTAMP NULL DEFAULT NULL,
        rejection_reason TEXT NULL,
        assigned_vehicle_id INT NULL,
        driver_name VARCHAR(150) NULL,
        driver_mobile VARCHAR(30) NULL,
        actual_return_at DATETIME NULL,
        returned_late TINYINT(1) NULL,
        time_extension_status ENUM('none','requested','approved','rejected') NOT NULL DEFAULT 'none',
        time_extension_note TEXT NULL,
        time_extension_decided_by INT NULL,
        hr_notice_flag TINYINT(1) NOT NULL DEFAULT 0,
        hr_manual_note TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (assigned_vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL,
        FOREIGN KEY (time_extension_decided_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure vehicle_requisitions table exists: " + err.message);
  }
  // Widen status for installs created before the Dynamic Approval Engine
  // integration added the 'ongoing' status (workflow-approved but not yet
  // vehicle+driver assigned is 'approved'; assigned and the ride actually
  // underway is 'ongoing' — previously 'approved' meant what 'ongoing' means
  // now, back when this file did its own direct approve+assign in one step).
  try {
    await dbPool.query(
      `ALTER TABLE vehicle_requisitions MODIFY COLUMN status ENUM('pending','approved','ongoing','rejected','cancelled','completed') NOT NULL DEFAULT 'pending'`
    );
  } catch (err: any) {
    console.warn("⚠️ Could not widen vehicle_requisitions.status to include 'ongoing': " + err.message);
  }
}

export function registerVehicleManagementRoutes(app: Express, deps: VehicleManagementRouteDeps) {
  const {
    authenticateToken,
    requireAdmin,
    requireModule,
    queryDB,
    getAdminModules,
    createAlert,
    createTemplateApprovalRequest,
    getCurrentStepApprovers,
    finalizeVehicleRequisitionApproval
  } = deps;
  const adminGate = [authenticateToken, requireAdmin, requireModule("vehicle_management")];

  async function canManage(userId: number, role: string): Promise<boolean> {
    if (role === "superadmin") return true;
    if (role !== "admin" && role !== "user") return false;
    const modules = await getAdminModules(userId);
    return modules.includes("vehicle_management");
  }

  function computeExpectedReturn(ride_date: string, start_time: string, durationHours: number): Date {
    const start = new Date(`${ride_date}T${start_time.length === 5 ? start_time : start_time.padStart(5, "0")}:00`);
    return new Date(start.getTime() + durationHours * 60 * 60 * 1000);
  }

  // Resolves who a 'pending' requisition's Approval Workflow is CURRENTLY
  // waiting on — same idea as AssetManagementRoutes.ts's own
  // attachPendingApprover, kept a plain any[]-in/out helper for the same
  // reason (avoids fighting TS generic inference when chained with other
  // per-row enrichment).
  async function attachPendingApprover(rows: any[]): Promise<any[]> {
    const pendingIds = new Set(rows.filter((r) => r.status === "pending").map((r) => r.id));
    if (pendingIds.size === 0) return rows.map((r) => ({ ...r, pending_with: null }));

    const requestRows = await queryDB("SELECT * FROM approval_requests WHERE source_type = ?", ["vehicle_requisition"]);
    const requestByRequisitionId = new Map<number, any>(
      requestRows
        .filter((rr: any) => rr.status === "pending" && pendingIds.has(Number(rr.source_id)))
        .map((rr: any) => [Number(rr.source_id), rr])
    );

    const result: any[] = [];
    for (const r of rows) {
      const request = requestByRequisitionId.get(r.id);
      if (!request) {
        result.push({ ...r, pending_with: null });
        continue;
      }
      const approvers = await getCurrentStepApprovers(request);
      const names = approvers.map((a) => a.user_name).filter((n): n is string => !!n);
      result.push({ ...r, pending_with: names.length > 0 ? names.join(", ") : null });
    }
    return result;
  }

  // Was this account the one who cast the FINAL 'approved' action that
  // actually cleared a requisition's Approval Workflow (the last entry in
  // approval_requests.actions_json)? Answers "the person who approved this
  // may want to also finish the job (assign a vehicle+driver) without
  // needing a SEPARATE 'vehicle_management' Module Access grant on top of
  // already being trusted as a Template approver" — see PUT
  // .../requisitions/:id/assign and GET .../awaiting-my-assignment below.
  // Deliberately only the LAST action (not any earlier Layer, e.g. the
  // Supervisor auto-layer) — the flowchart's "গাড়ি ও ড্রাইভার অ্যাসাইনমেন্ট"
  // step is specifically HR/Admin's job, the Layer that actually cleared it.
  async function wasFinalApprover(requisitionId: number, userId: number): Promise<boolean> {
    const requestRows: any = await queryDB("SELECT * FROM approval_requests WHERE source_type = ?", ["vehicle_requisition"]);
    const request = requestRows.find((r: any) => Number(r.source_id) === requisitionId);
    if (!request) return false;
    let actions: any[] = [];
    try {
      actions = JSON.parse(request.actions_json || "[]");
    } catch {
      actions = [];
    }
    const last = actions[actions.length - 1];
    return !!last && last.action === "approved" && Number(last.approver_id) === Number(userId);
  }

  function serialize(r: any, userById: Map<number, any>, vehicleById: Map<number, any>) {
    const vehicle = r.assigned_vehicle_id ? vehicleById.get(Number(r.assigned_vehicle_id)) : null;
    return {
      id: Number(r.id),
      employee_user_id: Number(r.employee_user_id),
      employee_name: userById.get(Number(r.employee_user_id))?.name || null,
      purpose: r.purpose,
      pickup_location: r.pickup_location,
      destination: r.destination,
      ride_date: r.ride_date,
      start_time: r.start_time,
      estimated_duration_hours: Number(r.estimated_duration_hours),
      expected_return_at: r.expected_return_at,
      status: r.status,
      // Who the Approval Workflow is currently waiting on (comma-joined —
      // ANY ONE of them clears the step) — null once past 'pending'.
      pending_with: r.pending_with ?? null,
      decided_by_name: r.decided_by ? userById.get(Number(r.decided_by))?.name || null : null,
      decided_at: r.decided_at,
      rejection_reason: r.rejection_reason,
      assigned_vehicle_id: r.assigned_vehicle_id ? Number(r.assigned_vehicle_id) : null,
      vehicle_no: vehicle?.vehicle_no || null,
      vehicle_model: vehicle?.model || null,
      driver_name: r.driver_name,
      driver_mobile: r.driver_mobile,
      actual_return_at: r.actual_return_at,
      returned_late: r.returned_late === null || r.returned_late === undefined ? null : !!Number(r.returned_late),
      time_extension_status: r.time_extension_status,
      time_extension_note: r.time_extension_note,
      hr_notice_flag: !!Number(r.hr_notice_flag),
      hr_manual_note: r.hr_manual_note,
      created_at: r.created_at
    };
  }

  async function loadContext() {
    const [rows, users, vehicles]: [any, any, any] = await Promise.all([
      queryDB("SELECT * FROM vehicle_requisitions"),
      queryDB("SELECT id, name FROM users"),
      queryDB("SELECT * FROM vehicles")
    ]);
    const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
    const vehicleById = new Map<number, any>(vehicles.map((v: any): [number, any] => [Number(v.id), v]));
    return { rows, userById, vehicleById };
  }

  // ---------------------------------------------------------------------
  // Self Service -> "Book a Ride" / "Ride Status"
  // ---------------------------------------------------------------------

  // GET /api/vehicles/requisitions — a module-granted account (or
  // Superadmin) sees every ride request; anyone else only ever sees their
  // own (covers both the employee's "Ride Status" list and the Admin
  // Panel's "Ride Requests" board from one endpoint).
  app.get("/api/vehicles/requisitions", authenticateToken, async (req: any, res: any) => {
    try {
      const manage = await canManage(req.user.id, req.user.role);
      const { rows, userById, vehicleById } = await loadContext();
      const scoped = manage ? rows : rows.filter((r: any) => Number(r.employee_user_id) === Number(req.user.id));
      const sorted = scoped.sort((a: any, b: any) => Number(b.id) - Number(a.id));
      const withPending = await attachPendingApprover(sorted);
      res.json(withPending.map((r: any) => serialize(r, userById, vehicleById)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/vehicles/requisitions/awaiting-my-assignment — the OTHER half
  // of the "who does the Assign Vehicle & Driver step" problem: an account
  // named as a Template approver (Admin Panel -> Approvals -> Templates)
  // may hold NO 'vehicle_management' Module Access at all, so it has no
  // Admin Panel page to go finish the job on once it approves. This is that
  // page's self-service equivalent — no module gate, just "did I approve
  // this" (wasFinalApprover) — so the exact same account that cleared the
  // Approval Workflow can see and act on its own approved-but-unassigned
  // requisitions without a Superadmin having to grant it Admin Panel access
  // on top of already being trusted as an approver.
  app.get("/api/vehicles/requisitions/awaiting-my-assignment", authenticateToken, async (req: any, res: any) => {
    try {
      const { rows, userById, vehicleById } = await loadContext();
      const approved = rows.filter((r: any) => r.status === "approved");
      const mine: any[] = [];
      for (const r of approved) {
        if (await wasFinalApprover(Number(r.id), req.user.id)) mine.push(r);
      }
      const sorted = mine.sort((a: any, b: any) => Number(b.id) - Number(a.id));
      res.json(sorted.map((r: any) => serialize(r, userById, vehicleById)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/vehicles/available — no module gate, just enough (id/vehicle_no/
  // model/vehicle_type) for the vehicle picker on PUT .../assign below, so an
  // approver acting via the self-service route above can still pick a
  // vehicle without 'vehicle_management' Module Access. GET /api/vehicles
  // (the full inventory record, Admin Panel's own list) stays module-gated.
  app.get("/api/vehicles/available", authenticateToken, async (_req: any, res: any) => {
    try {
      const rows: any = await queryDB("SELECT * FROM vehicles");
      res.json(
        rows
          .filter((v: any) => v.status === "available")
          .map((v: any) => ({ id: Number(v.id), vehicle_no: v.vehicle_no, model: v.model, vehicle_type: v.vehicle_type }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Shared by POST /api/vehicles/requisitions (self-service "Book a Ride")
  // and POST /api/vehicles/requisitions/admin-create (flowchart's "জরুরি/HR
  // Direct" initiator path) — validates the ride form, inserts the row, and
  // routes it through the Dynamic Approval Engine (request_type 'vehicle':
  // Layer 1 the requester's own Supervisor unless overridden, Layer 2+
  // "HR/Admin Review"), notifying whoever it lands on first. Throws a plain
  // Error with a message safe to send straight back to the client on bad
  // input; the caller is responsible for the try/catch + response.
  async function submitRequisition(
    body: any,
    employeeUserId: number,
    actor: { id: number; name?: string },
    overrideSupervisorId?: number | null
  ) {
    const purpose = typeof body.purpose === "string" ? body.purpose.trim().slice(0, 2000) : "";
    const pickup = typeof body.pickup_location === "string" ? body.pickup_location.trim().slice(0, 255) : "";
    const destination = typeof body.destination === "string" ? body.destination.trim().slice(0, 255) : "";
    const rideDate = typeof body.ride_date === "string" ? body.ride_date : "";
    const startTime = typeof body.start_time === "string" ? body.start_time : "";
    const duration = Number(body.estimated_duration_hours);

    if (!purpose) throw new Error("Purpose is required.");
    if (!pickup) throw new Error("Pickup location is required.");
    if (!destination) throw new Error("Destination is required.");
    if (!rideDate) throw new Error("Ride date is required.");
    if (!startTime) throw new Error("Start time is required.");
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Estimated duration must be greater than 0 hours.");
    }

    const expectedReturn = computeExpectedReturn(rideDate, startTime, duration);

    // time_extension_status/hr_notice_flag are explicitly listed here
    // (rather than relying on the columns' own SQL DEFAULT) because the
    // in-memory dev fallback's generic INSERT simulator only ever sets
    // whatever's in this column list — leaving them out would leave the
    // in-memory row's time_extension_status literally `undefined`, and
    // `undefined !== "none"` reads as "an extension WAS requested" in the
    // late-return check inside POST .../complete below.
    const result: any = await queryDB(
      `INSERT INTO vehicle_requisitions
         (employee_user_id, purpose, pickup_location, destination, ride_date, start_time,
          estimated_duration_hours, expected_return_at, status, time_extension_status, hr_notice_flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [employeeUserId, purpose, pickup, destination, rideDate, startTime, duration, expectedReturn, "pending", "none", 0]
    );

    // Dynamic Approval Engine — routed through this Employee's assigned
    // Template for request_type 'vehicle'. Falls back to a straight
    // auto-approve if neither a Supervisor nor a Template resolve at all.
    const { autoApproved } = await createTemplateApprovalRequest(
      "vehicle",
      "vehicle_requisition",
      result.insertId,
      employeeUserId,
      overrideSupervisorId
    );
    if (autoApproved) {
      try {
        await finalizeVehicleRequisitionApproval(result.insertId, actor.id, null);
      } catch (finalizeErr: any) {
        console.warn("⚠️ Could not auto-process Vehicle Requisition #" + result.insertId + ": " + finalizeErr.message);
      }
    } else {
      try {
        const requestRows = await queryDB("SELECT * FROM approval_requests WHERE source_type = ?", ["vehicle_requisition"]);
        const createdRequest = requestRows.find((r: any) => Number(r.source_id) === Number(result.insertId));
        if (createdRequest) {
          const approvers = await getCurrentStepApprovers(createdRequest);
          for (const approver of approvers) {
            await createAlert(queryDB, {
              userId: approver.user_id,
              type: "vehicle_requisition" as AlertType,
              title: "New Ride Request Awaiting Your Approval",
              message: `${actor.name || "An employee"} requested a ride (${pickup} → ${destination}). Please review.`,
              relatedType: "vehicle_requisition",
              relatedId: result.insertId
            });
          }
        }
      } catch (alertErr: any) {
        console.warn("⚠️ Could not notify the current-step approver for Vehicle Requisition #" + result.insertId + ": " + alertErr.message);
      }
    }

    const { rows, userById, vehicleById } = await loadContext();
    const created = rows.find((r: any) => Number(r.id) === Number(result.insertId));
    const [withPending] = await attachPendingApprover([created]);
    return serialize(withPending, userById, vehicleById);
  }

  // POST /api/vehicles/requisitions — "Book a Ride": the requester submits
  // their own request (flowchart's "সাধারণ ইউজার" path).
  app.post("/api/vehicles/requisitions", authenticateToken, async (req: any, res: any) => {
    try {
      const result = await submitRequisition(req.body, req.user.id, req.user);
      res.status(201).json(result);
    } catch (err: any) {
      res.status(err.message?.endsWith(".") ? 400 : 500).json({ error: err.message });
    }
  });

  // POST /api/vehicles/requisitions/admin-create — flowchart's "জরুরি/HR
  // Direct" initiator path: HR/Admin manually files a requisition on
  // someone else's behalf (emergency, or the requester can't do it
  // themselves) — "ইনিশিয়েটর কে/ধরন?" -> "HR/Admin ম্যানুয়ালি ইউজার সিলেক্ট
  // করবেন" in the flowchart. Optionally names a specific approver for the
  // Supervisor Layer (supervisor_user_id) instead of relying on that
  // employee's own auto-resolved Direct/Department Supervisor — useful when
  // there isn't one set, or HR wants a specific person to review this one
  // emergency request. Still routes through the same Approval Workflow
  // (Layer 2+ "HR/Admin Review") otherwise.
  app.post("/api/vehicles/requisitions/admin-create", ...adminGate, async (req: any, res: any) => {
    try {
      const employeeUserId = Number(req.body?.employee_user_id);
      if (!Number.isFinite(employeeUserId)) return res.status(400).json({ error: "Pick who this ride is for." });
      const employeeRows: any = await queryDB("SELECT id FROM users WHERE id = ?", [employeeUserId]);
      if (employeeRows.length === 0) return res.status(404).json({ error: "That account was not found." });

      let overrideSupervisorId: number | null | undefined;
      if (req.body?.supervisor_user_id !== undefined && req.body?.supervisor_user_id !== null && req.body?.supervisor_user_id !== "") {
        overrideSupervisorId = Number(req.body.supervisor_user_id);
        const supRows: any = await queryDB("SELECT id FROM users WHERE id = ?", [overrideSupervisorId]);
        if (supRows.length === 0) return res.status(404).json({ error: "That Supervisor approver account was not found." });
      }

      const result = await submitRequisition(req.body, employeeUserId, req.user, overrideSupervisorId);
      res.status(201).json(result);
    } catch (err: any) {
      res.status(err.message?.endsWith(".") ? 400 : 500).json({ error: err.message });
    }
  });

  // POST /api/vehicles/requisitions/:id/cancel — the requester cancels
  // their own still-pending request (flowchart's "ক্যানসেল" branch, self-
  // initiated). Also clears the matching pending Approval Workflow request
  // (if one was created) so it stops showing up in an approver's queue for
  // a ride nobody is waiting on anymore.
  app.post("/api/vehicles/requisitions/:id/cancel", authenticateToken, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const rows: any = await queryDB("SELECT * FROM vehicle_requisitions WHERE id = ?", [id]);
      const requisition = rows[0];
      if (!requisition) return res.status(404).json({ error: "Requisition not found." });
      if (Number(requisition.employee_user_id) !== Number(req.user.id)) return res.status(403).json({ error: "Not authorized." });
      if (requisition.status !== "pending") return res.status(400).json({ error: "Only a pending request can be cancelled." });

      await queryDB("UPDATE vehicle_requisitions SET status = ?, decided_at = ? WHERE id = ?", ["cancelled", new Date(), id]);

      const requestRows: any = await queryDB("SELECT * FROM approval_requests WHERE source_type = ?", ["vehicle_requisition"]);
      const pendingRequest = requestRows.find((r: any) => Number(r.source_id) === id && r.status === "pending");
      if (pendingRequest) {
        await queryDB("UPDATE approval_requests SET status = ? WHERE id = ?", ["rejected", pendingRequest.id]);
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/vehicles/requisitions/:id/request-extension — flowchart's
  // "ইউজার পূর্বে সিস্টেমে ইনফর্ম করেছে?" branch: while the ride is Ongoing
  // (vehicle+driver already assigned), the requester flags they'll be late
  // so HR/Admin can approve the extension — this is what later tells the
  // on-time check the requester DID inform the system beforehand.
  app.post("/api/vehicles/requisitions/:id/request-extension", authenticateToken, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const note = typeof (req.body || {}).note === "string" ? req.body.note.trim().slice(0, 1000) : "";
      const rows: any = await queryDB("SELECT * FROM vehicle_requisitions WHERE id = ?", [id]);
      const requisition = rows[0];
      if (!requisition) return res.status(404).json({ error: "Requisition not found." });
      if (Number(requisition.employee_user_id) !== Number(req.user.id)) return res.status(403).json({ error: "Not authorized." });
      if (requisition.status !== "ongoing") return res.status(400).json({ error: "Only an ongoing ride can request a time extension." });

      await queryDB(
        "UPDATE vehicle_requisitions SET time_extension_status = ?, time_extension_note = ?, time_extension_decided_by = ? WHERE id = ?",
        ["requested", note || null, null, id]
      );

      if (requisition.decided_by) {
        await createAlert(queryDB, {
          userId: Number(requisition.decided_by),
          type: "vehicle_requisition" as AlertType,
          title: "Time Extension Requested",
          message: `${req.user.name || "An employee"} requested more time for their ride (${requisition.pickup_location} → ${requisition.destination}).`,
          relatedType: "vehicle_requisition",
          relatedId: id
        });
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/vehicles/requisitions/:id/complete — flowchart's "রাইড
  // সম্পন্ন ও গাড়ি ফেরত": the requester (or IT/Admin) reports the ride is
  // done and the vehicle is back. Frees the vehicle and runs the "নির্ধারিত
  // সময়ে ফেরত এসেছে?" check — late + no prior extension request raises
  // hr_notice_flag for HR to manually close out (see PUT .../resolve-notice
  // below); late + an extension already requested/approved needs no flag,
  // since the system was informed beforehand either way.
  app.post("/api/vehicles/requisitions/:id/complete", authenticateToken, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const rows: any = await queryDB("SELECT * FROM vehicle_requisitions WHERE id = ?", [id]);
      const requisition = rows[0];
      if (!requisition) return res.status(404).json({ error: "Requisition not found." });
      const manage = await canManage(req.user.id, req.user.role);
      if (!manage && Number(requisition.employee_user_id) !== Number(req.user.id)) return res.status(403).json({ error: "Not authorized." });
      if (requisition.status !== "ongoing") return res.status(400).json({ error: "Only an ongoing ride can be marked completed." });

      const now = new Date();
      const expected = requisition.expected_return_at ? new Date(requisition.expected_return_at) : null;
      const late = expected ? now.getTime() > expected.getTime() : false;
      const informedBeforehand = !!requisition.time_extension_status && requisition.time_extension_status !== "none";
      const noticeFlag = late && !informedBeforehand;

      await queryDB(
        "UPDATE vehicle_requisitions SET status = ?, actual_return_at = ?, returned_late = ?, hr_notice_flag = ? WHERE id = ?",
        ["completed", now, late ? 1 : 0, noticeFlag ? 1 : 0, id]
      );

      if (requisition.assigned_vehicle_id) {
        await queryDB("UPDATE vehicles SET status = ? WHERE id = ?", ["available", requisition.assigned_vehicle_id]);
      }

      if (late && informedBeforehand && requisition.time_extension_status === "requested") {
        // The requester DID inform the system beforehand — auto-clear the
        // extension to Approved rather than leaving it stuck "requested"
        // now that the ride itself is already closed.
        await queryDB("UPDATE vehicle_requisitions SET time_extension_status = ? WHERE id = ?", ["approved", id]);
      }

      if (noticeFlag) {
        const admins = await queryDB("SELECT id, name FROM users WHERE role IN ('admin','superadmin')");
        for (const a of admins as any[]) {
          await createAlert(queryDB, {
            userId: Number(a.id),
            type: "vehicle_requisition" as AlertType,
            title: "Late Vehicle Return — No Prior Notice",
            message: `${requisition.driver_name ? `Vehicle for ${req.user.name || "an employee"}` : "A ride"} returned late with no advance notice — please add a manual note.`,
            relatedType: "vehicle_requisition",
            relatedId: id
          });
        }
      }

      res.json({ success: true, returned_late: late, hr_notice_flag: noticeFlag });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------
  // Admin Panel -> Vehicle Management — gated behind the
  // 'vehicle_management' AdminModuleKey. Approve/Reject itself is done from
  // the generic Approval Workflow queue (Admin Panel -> Approvals), not from
  // here — see the design note above registerVehicleManagementRoutes.
  // ---------------------------------------------------------------------

  app.get("/api/vehicles", ...adminGate, async (_req: any, res: any) => {
    try {
      const rows: any = await queryDB("SELECT * FROM vehicles");
      res.json(rows.sort((a: any, b: any) => Number(b.id) - Number(a.id)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/vehicles", ...adminGate, async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const vehicleNo = typeof body.vehicle_no === "string" ? body.vehicle_no.trim().slice(0, 50) : "";
      const model = typeof body.model === "string" ? body.model.trim().slice(0, 150) : "";
      const vehicleType = typeof body.vehicle_type === "string" ? body.vehicle_type.trim().slice(0, 50) || null : null;
      if (!vehicleNo) return res.status(400).json({ error: "Vehicle No. is required." });
      if (!model) return res.status(400).json({ error: "Model is required." });

      const existing: any = await queryDB("SELECT * FROM vehicles");
      if (existing.some((v: any) => String(v.vehicle_no).toLowerCase() === vehicleNo.toLowerCase())) {
        return res.status(400).json({ error: "That Vehicle No. already exists." });
      }

      const result: any = await queryDB(
        "INSERT INTO vehicles (vehicle_no, model, vehicle_type, status, created_by) VALUES (?, ?, ?, ?, ?)",
        [vehicleNo, model, vehicleType, "available", req.user.id]
      );
      res.status(201).json({ success: true, id: Number(result.insertId) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/vehicles/:id", ...adminGate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const existingRows: any = await queryDB("SELECT * FROM vehicles WHERE id = ?", [id]);
      const existing = existingRows[0];
      if (!existing) return res.status(404).json({ error: "Vehicle not found." });
      const body = req.body || {};
      const model = typeof body.model === "string" && body.model.trim() ? body.model.trim().slice(0, 150) : existing.model;
      const vehicleType = body.vehicle_type !== undefined ? (String(body.vehicle_type || "").trim().slice(0, 50) || null) : existing.vehicle_type;
      const status = ["available", "on_ride", "maintenance"].includes(body.status) ? body.status : existing.status;
      await queryDB("UPDATE vehicles SET model = ?, vehicle_type = ?, status = ? WHERE id = ?", [model, vehicleType, status, id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/vehicles/requisitions/:id/assign — flowchart's "গাড়ি ও
  // ড্রাইভার অ্যাসাইনমেন্ট" step, done once the Approval Workflow has
  // already cleared this requisition (status 'approved'): IT/Admin picks an
  // available vehicle and records the driver's name/mobile, then notifies
  // the requester (flowchart's "ইউজারকে কনফার্মেশন ও ড্রাইভার ডিটেইলস
  // নোটিফিকেশন প্রেরণ"). Moves the ride into 'ongoing'.
  //
  // NOT module-gated the way every other Admin Panel route in this file is —
  // a plain 'vehicle_management' Module Access grant is one way in, but the
  // account that just cleared this SPECIFIC requisition's Approval Workflow
  // (wasFinalApprover) is also allowed to finish the job, since the
  // flowchart's HR/Admin actor is expected to review AND assign in one go —
  // see GET .../awaiting-my-assignment above for where that account finds
  // this action without any Admin Panel access at all.
  app.put("/api/vehicles/requisitions/:id/assign", authenticateToken, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const manage = await canManage(req.user.id, req.user.role);
      if (!manage && !(await wasFinalApprover(id, req.user.id))) {
        return res
          .status(403)
          .json({ error: "You need Vehicle Management access, or to be this request's approver, to assign a vehicle." });
      }
      const body = req.body || {};
      const vehicleId = Number(body.vehicle_id);
      const driverName = typeof body.driver_name === "string" ? body.driver_name.trim().slice(0, 150) : "";
      const driverMobile = typeof body.driver_mobile === "string" ? body.driver_mobile.trim().slice(0, 30) : "";
      if (!vehicleId) return res.status(400).json({ error: "Pick a vehicle." });
      if (!driverName) return res.status(400).json({ error: "Driver name is required." });
      if (!driverMobile) return res.status(400).json({ error: "Driver mobile number is required." });

      const reqRows: any = await queryDB("SELECT * FROM vehicle_requisitions WHERE id = ?", [id]);
      const requisition = reqRows[0];
      if (!requisition) return res.status(404).json({ error: "Requisition not found." });
      if (requisition.status !== "approved") {
        return res.status(400).json({ error: "This requisition must be Approved (by the Approval Workflow) before a vehicle can be assigned." });
      }

      const vehicleRows: any = await queryDB("SELECT * FROM vehicles WHERE id = ?", [vehicleId]);
      const vehicle = vehicleRows[0];
      if (!vehicle) return res.status(404).json({ error: "Vehicle not found." });
      if (vehicle.status !== "available") return res.status(400).json({ error: "That vehicle is not currently available." });

      await queryDB(
        "UPDATE vehicle_requisitions SET status = ?, assigned_vehicle_id = ?, driver_name = ?, driver_mobile = ? WHERE id = ?",
        ["ongoing", vehicleId, driverName, driverMobile, id]
      );
      await queryDB("UPDATE vehicles SET status = ? WHERE id = ?", ["on_ride", vehicleId]);

      await createAlert(queryDB, {
        userId: Number(requisition.employee_user_id),
        type: "vehicle_requisition" as AlertType,
        title: "Vehicle Assigned",
        message: `Your ride (${requisition.pickup_location} → ${requisition.destination}) is confirmed. Driver: ${driverName} (${driverMobile}), Vehicle: ${vehicle.vehicle_no}.`,
        relatedType: "vehicle_requisition",
        relatedId: id
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/vehicles/requisitions/:id/extension-decision — HR/Admin
  // approves or rejects a still-open time extension request while the ride
  // is ongoing.
  app.put("/api/vehicles/requisitions/:id/extension-decision", ...adminGate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const decision = req.body?.decision === "approved" ? "approved" : req.body?.decision === "rejected" ? "rejected" : null;
      if (!decision) return res.status(400).json({ error: "decision must be 'approved' or 'rejected'." });

      const reqRows: any = await queryDB("SELECT * FROM vehicle_requisitions WHERE id = ?", [id]);
      const requisition = reqRows[0];
      if (!requisition) return res.status(404).json({ error: "Requisition not found." });
      if (requisition.time_extension_status !== "requested") return res.status(400).json({ error: "No pending time extension request." });

      await queryDB("UPDATE vehicle_requisitions SET time_extension_status = ?, time_extension_decided_by = ? WHERE id = ?", [
        decision,
        req.user.id,
        id
      ]);

      await createAlert(queryDB, {
        userId: Number(requisition.employee_user_id),
        type: "vehicle_requisition" as AlertType,
        title: decision === "approved" ? "Time Extension Approved" : "Time Extension Rejected",
        message: `Your request for more time was ${decision}.`,
        relatedType: "vehicle_requisition",
        relatedId: id
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/vehicles/requisitions/:id/resolve-notice — flowchart's "HR
  // ম্যানুয়ালি এন্ট্রি ও নোটিশ ফ্ল্যাগ প্রদান করবে": HR closes out a late
  // return that had no advance notice, with a manual note on file.
  app.put("/api/vehicles/requisitions/:id/resolve-notice", ...adminGate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const note = typeof (req.body || {}).hr_manual_note === "string" ? req.body.hr_manual_note.trim().slice(0, 2000) : "";
      if (!note) return res.status(400).json({ error: "Add a note before clearing this flag." });

      const reqRows: any = await queryDB("SELECT * FROM vehicle_requisitions WHERE id = ?", [id]);
      const requisition = reqRows[0];
      if (!requisition) return res.status(404).json({ error: "Requisition not found." });
      if (!Number(requisition.hr_notice_flag)) return res.status(400).json({ error: "This request has no open notice flag." });

      await queryDB("UPDATE vehicle_requisitions SET hr_notice_flag = ?, hr_manual_note = ? WHERE id = ?", [0, note, id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
