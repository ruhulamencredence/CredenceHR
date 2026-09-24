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
// Deliberately NOT routed through the Dynamic Approval Engine (unlike Asset
// Requisition) — the flowchart itself only has one review step (HR/Admin),
// no Supervisor layer, so a plain direct approve/reject here matches it
// exactly and keeps this module self-contained.
//
// Same convention as GrievanceRoutes.ts/ExitOffboardingRoutes.ts: every
// write route only ever does `WHERE id = ?`, filtering/joins happen in JS
// after a full-table SELECT, and every INSERT/UPDATE is all-`?`-placeholders
// so the in-memory dev fallback's generic positional simulator (see
// simulateGenericTable in memoryDbFallback.ts) stays correct with zero
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
        status ENUM('pending','approved','rejected','cancelled','completed') NOT NULL DEFAULT 'pending',
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
}

export function registerVehicleManagementRoutes(app: Express, deps: VehicleManagementRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB, getAdminModules, createAlert } = deps;
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

  async function serialize(r: any, userById: Map<number, any>, vehicleById: Map<number, any>) {
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
      res.json(await Promise.all(sorted.map((r: any) => serialize(r, userById, vehicleById))));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/vehicles/requisitions — "Book a Ride": submit a new request.
  app.post("/api/vehicles/requisitions", authenticateToken, async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const purpose = typeof body.purpose === "string" ? body.purpose.trim().slice(0, 2000) : "";
      const pickup = typeof body.pickup_location === "string" ? body.pickup_location.trim().slice(0, 255) : "";
      const destination = typeof body.destination === "string" ? body.destination.trim().slice(0, 255) : "";
      const rideDate = typeof body.ride_date === "string" ? body.ride_date : "";
      const startTime = typeof body.start_time === "string" ? body.start_time : "";
      const duration = Number(body.estimated_duration_hours);

      if (!purpose) return res.status(400).json({ error: "Purpose is required." });
      if (!pickup) return res.status(400).json({ error: "Pickup location is required." });
      if (!destination) return res.status(400).json({ error: "Destination is required." });
      if (!rideDate) return res.status(400).json({ error: "Ride date is required." });
      if (!startTime) return res.status(400).json({ error: "Start time is required." });
      if (!Number.isFinite(duration) || duration <= 0) {
        return res.status(400).json({ error: "Estimated duration must be greater than 0 hours." });
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
        [req.user.id, purpose, pickup, destination, rideDate, startTime, duration, expectedReturn, "pending", "none", 0]
      );

      const { rows, userById, vehicleById } = await loadContext();
      const created = rows.find((r: any) => Number(r.id) === Number(result.insertId));
      res.status(201).json(await serialize(created, userById, vehicleById));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/vehicles/requisitions/:id/cancel — the requester cancels
  // their own still-pending request (flowchart's "ক্যানসেল" branch).
  app.post("/api/vehicles/requisitions/:id/cancel", authenticateToken, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const rows: any = await queryDB("SELECT * FROM vehicle_requisitions WHERE id = ?", [id]);
      const requisition = rows[0];
      if (!requisition) return res.status(404).json({ error: "Requisition not found." });
      if (Number(requisition.employee_user_id) !== Number(req.user.id)) return res.status(403).json({ error: "Not authorized." });
      if (requisition.status !== "pending") return res.status(400).json({ error: "Only a pending request can be cancelled." });

      await queryDB("UPDATE vehicle_requisitions SET status = ?, decided_at = ? WHERE id = ?", ["cancelled", new Date(), id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/vehicles/requisitions/:id/request-extension — flowchart's
  // "ইউজার পূর্বে সিস্টেমে ইনফর্ম করেছে?" branch: while the ride is still
  // Approved/ongoing, the requester flags they'll be late so HR/Admin can
  // approve the extension — this is what later tells the on-time check the
  // requester DID inform the system beforehand.
  app.post("/api/vehicles/requisitions/:id/request-extension", authenticateToken, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const note = typeof (req.body || {}).note === "string" ? req.body.note.trim().slice(0, 1000) : "";
      const rows: any = await queryDB("SELECT * FROM vehicle_requisitions WHERE id = ?", [id]);
      const requisition = rows[0];
      if (!requisition) return res.status(404).json({ error: "Requisition not found." });
      if (Number(requisition.employee_user_id) !== Number(req.user.id)) return res.status(403).json({ error: "Not authorized." });
      if (requisition.status !== "approved") return res.status(400).json({ error: "Only an ongoing (Approved) ride can request a time extension." });

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
      if (requisition.status !== "approved") return res.status(400).json({ error: "Only an ongoing (Approved) ride can be marked completed." });

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
  // 'vehicle_management' AdminModuleKey.
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

  // PUT /api/vehicles/requisitions/:id/approve — flowchart's "HR/Admin
  // রিভিউ -> অ্যাপ্রুভড -> গাড়ি ও ড্রাইভার অ্যাসাইনমেন্ট" in one step: picks
  // an available vehicle and records the driver's name/mobile, then
  // notifies the requester (flowchart's "ইউজারকে কনফার্মেশন ও ড্রাইভার
  // ডিটেইলস নোটিফিকেশন প্রেরণ").
  app.put("/api/vehicles/requisitions/:id/approve", ...adminGate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
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
      if (requisition.status !== "pending") return res.status(400).json({ error: "This requisition was already decided." });

      const vehicleRows: any = await queryDB("SELECT * FROM vehicles WHERE id = ?", [vehicleId]);
      const vehicle = vehicleRows[0];
      if (!vehicle) return res.status(404).json({ error: "Vehicle not found." });
      if (vehicle.status !== "available") return res.status(400).json({ error: "That vehicle is not currently available." });

      await queryDB(
        "UPDATE vehicle_requisitions SET status = ?, decided_by = ?, decided_at = ?, assigned_vehicle_id = ?, driver_name = ?, driver_mobile = ? WHERE id = ?",
        ["approved", req.user.id, new Date(), vehicleId, driverName, driverMobile, id]
      );
      await queryDB("UPDATE vehicles SET status = ? WHERE id = ?", ["on_ride", vehicleId]);

      await createAlert(queryDB, {
        userId: Number(requisition.employee_user_id),
        type: "vehicle_requisition" as AlertType,
        title: "Ride Approved",
        message: `Your ride (${requisition.pickup_location} → ${requisition.destination}) is confirmed. Driver: ${driverName} (${driverMobile}), Vehicle: ${vehicle.vehicle_no}.`,
        relatedType: "vehicle_requisition",
        relatedId: id
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/vehicles/requisitions/:id/reject — flowchart's "ক্যানসেল ->
  // রিকুইজিশন ক্যানসেলড" branch off HR/Admin Review (e.g. no vehicle
  // available).
  app.put("/api/vehicles/requisitions/:id/reject", ...adminGate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const reason = typeof (req.body || {}).rejection_reason === "string" ? req.body.rejection_reason.trim().slice(0, 1000) : "";
      if (!reason) return res.status(400).json({ error: "Add a reason for rejecting this request." });

      const reqRows: any = await queryDB("SELECT * FROM vehicle_requisitions WHERE id = ?", [id]);
      const requisition = reqRows[0];
      if (!requisition) return res.status(404).json({ error: "Requisition not found." });
      if (requisition.status !== "pending") return res.status(400).json({ error: "This requisition was already decided." });

      await queryDB(
        "UPDATE vehicle_requisitions SET status = ?, decided_by = ?, decided_at = ?, rejection_reason = ? WHERE id = ?",
        ["rejected", req.user.id, new Date(), reason, id]
      );

      await createAlert(queryDB, {
        userId: Number(requisition.employee_user_id),
        type: "vehicle_requisition" as AlertType,
        title: "Ride Request Rejected",
        message: `Your ride request (${requisition.pickup_location} → ${requisition.destination}) was rejected: ${reason}`,
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
