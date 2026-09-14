/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Remote Attendance — check-in/check-out, status, mine, corrections
// (request + Admin approval), the Admin's full Attendance list, and the
// Attendance Reports (daily/monthly/department-wise). Split out of server.ts
// on purpose — server.ts is already ~9,900 lines in one file, so this moves
// out as-is (no logic changes) the same way Personal Data, Users, Holidays,
// and Conveyance Bill Claims already were. Registered from inside
// startServer() via registerAttendanceRoutes(), reusing that same request's
// `app`/`authenticateToken`/`queryDB`/etc. rather than creating a second
// Express app or a second DB connection.
//
// NOT included here (still in server.ts): the ZK biometric device routes
// (/api/zk-devices/*, /api/office-attendance) — a separate "office_attendance"
// module, not "Remote Attendance".
//
// Dependencies below are all defined elsewhere in server.ts and shared with
// other modules (e.g. createApprovalRequest/attachApprovalStatuses also back
// Leave/Claims, haversineMeters also backs Movement Claims), so they're
// threaded through as deps rather than duplicated or re-imported directly.

import type { Express } from "express";

interface AttendanceRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: string) => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  haversineMeters: (lat1: number, lng1: number, lat2: number, lng2: number) => number;
  todayInDhaka: () => string;
  createApprovalRequest: (...args: any[]) => Promise<any>;
  createTemplateApprovalRequest: (...args: any[]) => Promise<any>;
  finalizeAttendanceCorrection: (correctionId: number, approvedBy: number, remarks: string | null) => Promise<any>;
  rejectAttendanceCorrection: (correctionId: number, rejectedBy: number, remarks: string | null) => Promise<any>;
  attachApprovalStatuses: (sourceType: "attendance" | "claim", rows: any[]) => Promise<any[]>;
  attachAttendanceCorrectionApproval: (rows: any[]) => Promise<any[]>;
  getAdminModules: (userId: number) => Promise<string[]>;
  getHolidayMap: (...args: any[]) => any;
  // Department-wise scope for the 'attendance_reports' module only — see the
  // attendance_report_department_access table comment in server.ts's
  // initDB() for the full design. null = unrestricted (every Department
  // visible, same as before this feature existed); otherwise the exact list
  // of Department names (matching the all_employees.department mirror
  // column) this account may see on any of the three report routes below.
  getAttendanceReportDeptScope: (userId: number) => Promise<string[] | null>;
}

export function registerAttendanceRoutes(app: Express, deps: AttendanceRouteDeps) {
  const {
    authenticateToken,
    requireAdmin,
    requireModule,
    queryDB,
    haversineMeters,
    todayInDhaka,
    createApprovalRequest,
    createTemplateApprovalRequest,
    finalizeAttendanceCorrection,
    rejectAttendanceCorrection,
    attachApprovalStatuses,
    attachAttendanceCorrectionApproval,
    getAdminModules,
    getHolidayMap,
    getAttendanceReportDeptScope
  } = deps;

  // 2b. Remote Attendance — a User checks in/out for a Project they have access to;
  // the server only accepts it if the device's reported coordinates fall inside
  // that Project's location_radius circle around location_lat/location_lng (a
  // Project with no pin/radius set yet can't take attendance at all — nothing to
  // measure the distance against). One row per (user, project, calendar day):
  // Check In fills check_in_*, a later Check Out the same day fills check_out_*.

  // Which project IDs the calling user may act on for Remote Attendance —
  // every project for an Admin/Superadmin, only the ones explicitly granted
  // for a plain User (mirrors GET /api/projects's own visibility rule) —
  // UNLESS a Superadmin/Admin has pinned this account (role 'user' OR
  // 'admin') to exactly one Project for Attendance (users.attendance_project_id,
  // set via Admin Panel -> Users -> "Attend. Project"), in which case that one
  // Project overrides everything else below, even an otherwise-unrestricted
  // Admin. Never applies to 'superadmin' — it has no such column value.
  async function getAllowedProjectIds(userId: number, role: string): Promise<Set<number> | null> {
    if (role !== "superadmin") {
      const pinnedRows = await queryDB("SELECT attendance_project_id FROM users WHERE id = ?", [userId]);
      const pinned = pinnedRows.length > 0 ? pinnedRows[0].attendance_project_id : null;
      if (pinned != null) return new Set([Number(pinned)]);
    }
    if (role === "admin" || role === "superadmin") return null; // null = no restriction
    const perms = await queryDB("SELECT project_id FROM user_project_permissions WHERE user_id = ?", [userId]);
    return new Set(perms.map((p: any) => Number(p.project_id)));
  }

  // Loads the Project and validates it has a location + radius set, returning a
  // ready-to-use { project, distance } once the given lat/lng is confirmed to be
  // inside the circle — or sends the appropriate error response itself and
  // returns null so the caller can just `if (!ctx) return;`.
  async function resolveAttendanceLocation(req: any, res: any, project_id: number, lat: number, lng: number) {
    const allowed = await getAllowedProjectIds(req.user.id, req.user.role);
    if (allowed && !allowed.has(project_id)) {
      res.status(403).json({ error: "You don't have access to this project." });
      return null;
    }
    const projects = await queryDB("SELECT * FROM projects WHERE id = ?", [project_id]);
    if (projects.length === 0) {
      res.status(404).json({ error: "Project not found." });
      return null;
    }
    const project = projects[0];
    if (project.location_lat == null || project.location_lng == null) {
      res.status(400).json({ error: "This project has no location set yet. Ask your Admin to set it on the map." });
      return null;
    }
    if (!project.location_radius) {
      res.status(400).json({ error: "This project has no attendance radius set yet. Ask your Admin to set one on the map." });
      return null;
    }
    const distance = Math.round(
      haversineMeters(lat, lng, Number(project.location_lat), Number(project.location_lng))
    );
    if (distance > Number(project.location_radius)) {
      res.status(403).json({
        error: `You're ${distance}m away from ${project.project_name} — outside the allowed ${project.location_radius}m attendance circle.`,
        distance_m: distance,
        radius_m: Number(project.location_radius)
      });
      return null;
    }
    return { project, distance };
  }

  function parseAttendanceCoords(body: any): { project_id: number; lat: number; lng: number; remarks: string | null } | { error: string } {
    const project_id = Number(body.project_id);
    const lat = Number(body.latitude);
    const lng = Number(body.longitude);
    if (!project_id) return { error: "Project is required." };
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { error: "Couldn't read your current location. Please allow location access and try again." };
    }
    // Optional free-text note — trimmed, capped, and blank-becomes-null so an
    // empty textarea never stores an empty string.
    const remarks = typeof body.remarks === "string" ? body.remarks.trim().slice(0, 1000) || null : null;
    return { project_id, lat, lng, remarks };
  }

  // Gate for POST /api/attendance/check-in and /check-out — an account needs
  // can_use_attendance (Superadmin implicit) before it can record its own
  // Attendance at all, same idea as requireLeaveManager above. Checked fresh
  // against the DB rather than trusting the token, since an Admin can flip
  // this at any time and the account might still be mid-session.
  const requireAttendanceAccess = async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Access token required" });
    if (req.user.role === "superadmin") return next();
    try {
      const rows: any = await queryDB("SELECT can_use_attendance FROM users WHERE id = ?", [req.user.id]);
      if (rows.length === 0 || !Number(rows[0].can_use_attendance)) {
        return res.status(403).json({ error: "You don't have access to Remote Attendance. Ask your Superadmin to grant it." });
      }
      next();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  // Gate for Self Service -> Timesheet (GET /api/attendance/mine and
  // /api/attendance/corrections/mine below) — an account needs
  // can_view_timesheet (Superadmin implicit) before it can open Timesheet at
  // all, same on/off pattern as requireAttendanceAccess above but a separate
  // flag: can_use_attendance is about checking in/out, can_view_timesheet is
  // about browsing the resulting history. Both of these GET routes are used
  // ONLY by Timesheet.tsx / AttendanceCorrectionModal.tsx (opened from
  // there), so gating them here can't affect any other feature.
  const requireTimesheetAccess = async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Access token required" });
    if (req.user.role === "superadmin") return next();
    try {
      const rows: any = await queryDB("SELECT can_view_timesheet FROM users WHERE id = ?", [req.user.id]);
      if (rows.length > 0 && !!Number(rows[0].can_view_timesheet)) return next();
      return res.status(403).json({ error: "You don't have access to Timesheet. Ask your Superadmin to grant it." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  app.post("/api/attendance/check-in", authenticateToken, requireAttendanceAccess, async (req: any, res) => {
    try {
      const parsed = parseAttendanceCoords(req.body);
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      const { project_id, lat, lng, remarks } = parsed;

      const ctx = await resolveAttendanceLocation(req, res, project_id, lat, lng);
      if (!ctx) return;
      const { distance, project } = ctx;

      const today = todayInDhaka();
      const existing = await queryDB(
        "SELECT * FROM attendance WHERE user_id = ? AND project_id = ? AND attendance_date = ?",
        [req.user.id, project_id, today]
      );
      if (existing.length > 0 && existing[0].check_in_at) {
        return res.status(400).json({ error: "You've already checked in for this project today." });
      }

      // Office Attendance (ZKTeco) gate — if the linked Employee already has an
      // In Time today from the office biometric device, that's already this
      // User's effective In Time (see GET /api/attendance/status), so a fresh
      // GPS Check In for the day is blocked rather than creating a second,
      // conflicting In Time.
      const empForCheckIn = await queryDB(
        "SELECT zk_device_pin FROM all_employees WHERE user_id = ? AND zk_device_pin IS NOT NULL LIMIT 1",
        [req.user.id]
      );
      if (empForCheckIn.length > 0) {
        const officeInRows = await queryDB(
          "SELECT MIN(punch_time) AS check_in_at FROM zk_attendance_logs WHERE device_user_pin = ? AND DATE(punch_time) = ?",
          [empForCheckIn[0].zk_device_pin, today]
        );
        if (officeInRows.length > 0 && officeInRows[0].check_in_at) {
          return res.status(400).json({ error: "You're already marked present today via Office Attendance." });
        }
      }

      let attendanceId: number;
      if (existing.length > 0) {
        attendanceId = existing[0].id;
        await queryDB(
          "UPDATE attendance SET check_in_at = NOW(), check_in_lat = ?, check_in_lng = ?, check_in_distance_m = ?, check_in_remarks = ? WHERE id = ?",
          [lat, lng, distance, remarks, existing[0].id]
        );
      } else {
        const insertResult = await queryDB(
          "INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_in_lat, check_in_lng, check_in_distance_m, check_in_remarks) VALUES (?, ?, ?, NOW(), ?, ?, ?, ?)",
          [req.user.id, project_id, today, lat, lng, distance, remarks]
        );
        attendanceId = insertResult.insertId;
      }
      await createApprovalRequest("attendance", "check_in", attendanceId, req.user.id);
      res.json({ success: true, distance_m: distance, radius_m: Number(project.location_radius), project_name: project.project_name });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/attendance/check-out", authenticateToken, requireAttendanceAccess, async (req: any, res) => {
    try {
      const parsed = parseAttendanceCoords(req.body);
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      const { project_id, lat, lng, remarks } = parsed;

      const ctx = await resolveAttendanceLocation(req, res, project_id, lat, lng);
      if (!ctx) return;
      const { distance, project } = ctx;

      const today = todayInDhaka();
      const existing = await queryDB(
        "SELECT * FROM attendance WHERE user_id = ? AND project_id = ? AND attendance_date = ?",
        [req.user.id, project_id, today]
      );

      // Office Attendance (ZKTeco) fallback for the same In/Out gate this
      // endpoint already enforces — lets someone who only punched the office
      // biometric device (no Remote/GPS Check In row at all yet) still Check
      // Out over GPS, and blocks a second Check Out if the office device
      // already has an Out Time too. Never overrides a Remote value that
      // already exists (see hasRemoteCheckIn/hasRemoteCheckOut below).
      let officeCheckInAt: string | null = null;
      let officeCheckOutAt: string | null = null;
      const empForCheckOut = await queryDB(
        "SELECT zk_device_pin FROM all_employees WHERE user_id = ? AND zk_device_pin IS NOT NULL LIMIT 1",
        [req.user.id]
      );
      if (empForCheckOut.length > 0) {
        const officeRows = await queryDB(
          // COUNT(*) > 1 guard: with only one punch today (In Time only, no Out
          // yet), MIN and MAX both resolve to that same single row — without
          // the guard this would report an Out Time identical to the In Time,
          // wrongly telling this endpoint (and anyone reading it) that the
          // person had already checked out.
          `SELECT MIN(punch_time) AS check_in_at,
                  CASE WHEN COUNT(*) > 1 THEN MAX(punch_time) ELSE NULL END AS check_out_at
           FROM zk_attendance_logs WHERE device_user_pin = ? AND DATE(punch_time) = ?`,
          [empForCheckOut[0].zk_device_pin, today]
        );
        if (officeRows.length > 0) {
          officeCheckInAt = officeRows[0].check_in_at || null;
          officeCheckOutAt = officeRows[0].check_out_at || null;
        }
      }

      const hasRemoteCheckIn = existing.length > 0 && !!existing[0].check_in_at;
      const hasRemoteCheckOut = existing.length > 0 && !!existing[0].check_out_at;

      if (!hasRemoteCheckIn && !officeCheckInAt) {
        return res.status(400).json({ error: "You need to Check In for this project before you can Check Out." });
      }
      if (hasRemoteCheckOut || (!hasRemoteCheckIn && officeCheckOutAt)) {
        return res.status(400).json({ error: "You've already checked out for this project today." });
      }

      if (existing.length > 0) {
        await queryDB(
          "UPDATE attendance SET check_out_at = NOW(), check_out_lat = ?, check_out_lng = ?, check_out_distance_m = ?, check_out_remarks = ? WHERE id = ?",
          [lat, lng, distance, remarks, existing[0].id]
        );
        await createApprovalRequest("attendance", "check_out", existing[0].id, req.user.id);
      } else {
        // No Remote row yet — only reachable when Office Attendance already
        // covers the In Time (checked above). Create the row now so this
        // Check Out has somewhere to live, backfilling check_in_at from the
        // office punch so the row stays internally consistent.
        const insertResult = await queryDB(
          "INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_out_at, check_out_lat, check_out_lng, check_out_distance_m, check_out_remarks) VALUES (?, ?, ?, ?, NOW(), ?, ?, ?, ?)",
          [req.user.id, project_id, today, officeCheckInAt, lat, lng, distance, remarks]
        );
        await createApprovalRequest("attendance", "check_out", insertResult.insertId, req.user.id);
      }
      res.json({ success: true, distance_m: distance, radius_m: Number(project.location_radius), project_name: project.project_name });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Today's attendance row (if any) for the calling user + a given project — lets
  // the User Panel show the right Check In / Check Out button state on load/refresh.
  // Merges in Office Attendance (ZKTeco) as a fallback: whichever of
  // check_in_at/check_out_at the Remote (GPS) row doesn't already have gets
  // filled from the linked Employee's office biometric punch for today, if any
  // — so a User who already punched the office device shows up as checked in
  // here too (check_in_source/check_out_source say which one it came from).
  // A Remote value, once set, is never overridden by Office data.
  app.get("/api/attendance/status", authenticateToken, async (req: any, res) => {
    try {
      const project_id = Number(req.query.project_id);
      if (!project_id) return res.status(400).json({ error: "project_id is required" });
      const today = todayInDhaka();
      const rows = await queryDB(
        "SELECT * FROM attendance WHERE user_id = ? AND project_id = ? AND attendance_date = ?",
        [req.user.id, project_id, today]
      );
      const withApprovals = await attachApprovalStatuses("attendance", rows);
      const remoteRow: any = withApprovals[0] || null;

      let office: any = null;
      if (!remoteRow || !remoteRow.check_in_at || !remoteRow.check_out_at) {
        const emp = await queryDB(
          "SELECT zk_device_pin FROM all_employees WHERE user_id = ? AND zk_device_pin IS NOT NULL LIMIT 1",
          [req.user.id]
        );
        if (emp.length > 0) {
          const officeRows = await queryDB(
            // Same single-punch guard as check-out above — no Out Time yet
            // today means COUNT(*) is 1, so check_out_at must stay NULL
            // instead of falling back to the same value as check_in_at.
            `SELECT MIN(punch_time) AS check_in_at,
                    CASE WHEN COUNT(*) > 1 THEN MAX(punch_time) ELSE NULL END AS check_out_at
             FROM zk_attendance_logs WHERE device_user_pin = ? AND DATE(punch_time) = ?`,
            [emp[0].zk_device_pin, today]
          );
          if (officeRows.length > 0 && officeRows[0].check_in_at) office = officeRows[0];
        }
      }

      if (!remoteRow && !office) return res.json(null);

      const check_in_at = remoteRow?.check_in_at || office?.check_in_at || null;
      const check_out_at = remoteRow?.check_out_at || office?.check_out_at || null;

      res.json({
        id: remoteRow?.id ?? null,
        user_id: req.user.id,
        project_id,
        attendance_date: today,
        check_in_at,
        check_in_lat: remoteRow?.check_in_lat ?? null,
        check_in_lng: remoteRow?.check_in_lng ?? null,
        check_in_distance_m: remoteRow?.check_in_distance_m ?? null,
        check_in_remarks: remoteRow?.check_in_remarks ?? null,
        check_out_at,
        check_out_lat: remoteRow?.check_out_lat ?? null,
        check_out_lng: remoteRow?.check_out_lng ?? null,
        check_out_distance_m: remoteRow?.check_out_distance_m ?? null,
        check_out_remarks: remoteRow?.check_out_remarks ?? null,
        check_in_approval: remoteRow?.check_in_approval ?? null,
        check_out_approval: remoteRow?.check_out_approval ?? null,
        check_in_source: remoteRow?.check_in_at ? "remote" : office?.check_in_at ? "office" : null,
        check_out_source: remoteRow?.check_out_at ? "remote" : office?.check_out_at ? "office" : null
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The calling user's own attendance history (most recent first).
  app.get("/api/attendance/mine", authenticateToken, requireTimesheetAccess, async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM attendance WHERE user_id = ? ORDER BY attendance_date DESC, id DESC", [req.user.id]);
      const projects = await queryDB("SELECT * FROM projects");
      const projectMap = new Map<number, any>(projects.map((p: any) => [p.id, p]));
      const withApprovals = await attachApprovalStatuses("attendance", rows.slice(0, 200));
      const mapped = withApprovals.map((r: any) => ({
        ...r,
        project_name: projectMap.get(r.project_id)?.project_name || null
      }));

      // Office Attendance (ZKTeco) fallback — Timesheet was showing a day as
      // Absent whenever there was no Remote (GPS) row for it, even when the
      // person had punched the office biometric device that day. Same
      // gap-filler pattern as /api/attendance/status and the admin reports:
      // only used to add a date that has NO Remote row at all, never to
      // override one that already exists.
      const datesWithRemote = new Set(mapped.map((r: any) => String(r.attendance_date).slice(0, 10)));
      const emp = await queryDB(
        "SELECT zk_device_pin FROM all_employees WHERE user_id = ? AND zk_device_pin IS NOT NULL LIMIT 1",
        [req.user.id]
      );
      if (emp.length > 0) {
        const officeRows = await queryDB(
          // Same single-punch guard as the other zk_attendance_logs queries —
          // a day with only one punch so far has no Out Time yet.
          `SELECT DATE(punch_time) AS attendance_date,
                  MIN(punch_time) AS check_in_at,
                  CASE WHEN COUNT(*) > 1 THEN MAX(punch_time) ELSE NULL END AS check_out_at
           FROM zk_attendance_logs
           WHERE device_user_pin = ?
           GROUP BY DATE(punch_time)
           ORDER BY attendance_date DESC
           LIMIT 200`,
          [emp[0].zk_device_pin]
        );
        for (const o of officeRows) {
          const dateStr = String(o.attendance_date).slice(0, 10);
          if (datesWithRemote.has(dateStr)) continue;
          mapped.push({
            // Negative, date-derived id — keeps this synthetic row unique and
            // numeric like every real AttendanceRecord.id (real rows are
            // always positive auto-increment ids), and stable across
            // reloads (same date always yields the same id) so React's key
            // and the Correct Attendance modal keep working uneventfully.
            id: -Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000),
            user_id: req.user.id,
            project_id: 0,
            project_name: 'Office Attendance',
            attendance_date: dateStr,
            check_in_at: o.check_in_at,
            check_out_at: o.check_out_at
          });
        }
        mapped.sort((a: any, b: any) => String(b.attendance_date).localeCompare(String(a.attendance_date)));
      }

      res.json(mapped);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const MAX_ATTENDANCE_CORRECTION_FILE_BYTES = 5 * 1024 * 1024; // 5MB, matches user_claims' cap

  // Timesheet -> click any date's row -> "Correct Attendance" modal. Submits a
  // request to manually set that day's In Time/Out Time (e.g. the day shows
  // Absent because the User forgot to Check In/Out) with an optional reason and
  // an optional attachment. Never writes to `attendance` directly — see
  // finalizeAttendanceCorrection. If no global Approval Chain is configured yet,
  // auto-processes immediately (same backward-compatible convention as
  // Conveyance Bill Claims/POST /api/user-claims); otherwise it stays 'pending'
  // until the LAST step of the chain approves it from the existing Admin Panel
  // -> Approvals queue — no separate review page needed.
  app.post("/api/attendance/corrections", authenticateToken, requireAttendanceAccess, async (req: any, res) => {
    try {
      const { project_id, attendance_date, check_in_at, check_out_at, remarks, file_base64, file_name, file_mimetype } = req.body || {};

      let projectId = Number(project_id);
      // A Superadmin/Admin-pinned Attendance Project (users.attendance_project_id)
      // overrides whatever the client sent — Timesheet's Correct Attendance modal
      // already drops its own Project picker and only ever sends the pinned
      // Project once one is set (see AttendanceCorrectionModal.tsx), but this is
      // enforced here too so a direct API call can't file a correction against a
      // different Project, same defense-in-depth as resolveAttendanceLocation's
      // Check In/Out gate above. Never applies to 'superadmin'.
      if (req.user.role !== "superadmin") {
        const pinnedRows = await queryDB("SELECT attendance_project_id FROM users WHERE id = ?", [req.user.id]);
        const pinned = pinnedRows.length > 0 ? pinnedRows[0].attendance_project_id : null;
        if (pinned != null) projectId = Number(pinned);
      }
      if (!projectId) return res.status(400).json({ error: "Project is required." });
      if (!attendance_date) return res.status(400).json({ error: "Date is required." });
      const today = todayInDhaka();
      if (String(attendance_date) > today) return res.status(400).json({ error: "Can't correct a future date." });
      if (!check_in_at && !check_out_at) return res.status(400).json({ error: "Enter an In Time or Out Time to correct." });

      const projects = await queryDB("SELECT * FROM projects WHERE id = ?", [projectId]);
      if (projects.length === 0) return res.status(400).json({ error: "Project not found." });

      const pendingExisting = await queryDB(
        "SELECT id FROM attendance_corrections WHERE user_id = ? AND project_id = ? AND attendance_date = ? AND status = 'pending'",
        [req.user.id, projectId, attendance_date]
      );
      if (pendingExisting.length > 0) {
        return res.status(400).json({ error: "You already have a pending correction request for this date." });
      }

      const trimmedRemarks = typeof remarks === "string" ? remarks.trim().slice(0, 1000) || null : null;

      let fileBuffer: Buffer | null = null;
      if (file_base64 && typeof file_base64 === "string") {
        fileBuffer = Buffer.from(file_base64, "base64");
        if (fileBuffer.length > MAX_ATTENDANCE_CORRECTION_FILE_BYTES) {
          return res.status(400).json({ error: "Attachment must be 5MB or smaller." });
        }
      }

      const result = await queryDB(
        `INSERT INTO attendance_corrections
           (user_id, project_id, attendance_date, requested_check_in_at, requested_check_out_at, remarks, file_name, file_mimetype, file_data, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          req.user.id,
          projectId,
          attendance_date,
          check_in_at || null,
          check_out_at || null,
          trimmedRemarks,
          fileBuffer ? String(file_name || "attachment").slice(0, 255) : null,
          fileBuffer ? String(file_mimetype || "application/octet-stream") : null,
          fileBuffer
        ]
      );

      // Dynamic Approval Engine (Part 3) — Timesheet corrections are routed
      // through this Employee's assigned Template for request_type
      // 'timesheet' (falling back to that request_type's default, and to a
      // straight auto-approve if neither exists). This REPLACES the old
      // global-chain routing this endpoint used before — see the long
      // comment above createTemplateApprovalRequest().
      const { autoApproved } = await createTemplateApprovalRequest("timesheet", "attendance_correction", result.insertId, req.user.id);
      if (autoApproved) {
        try {
          await finalizeAttendanceCorrection(result.insertId, req.user.id, "Auto-approved (no Approval Template configured for Timesheet).");
        } catch (finalizeErr: any) {
          console.warn("⚠️ Could not auto-process attendance correction #" + result.insertId + ": " + finalizeErr.message);
        }
      }

      res.status(201).json({ success: true, id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to submit correction request" });
    }
  });

  // The calling user's own correction request history, most recent first —
  // lets Timesheet show a Pending/Rejected badge on the affected date's row
  // (an Approved one just shows up as that day's normal Present/In/Out Time,
  // since `attendance` itself was already updated).
  app.get("/api/attendance/corrections/mine", authenticateToken, requireTimesheetAccess, async (req: any, res) => {
    try {
      const rows = await queryDB(
        `SELECT id, user_id, project_id, attendance_date, requested_check_in_at, requested_check_out_at, remarks,
                file_name, file_mimetype, (file_data IS NOT NULL) AS has_file,
                status, admin_remarks, reviewed_by, reviewed_at, created_at
           FROM attendance_corrections WHERE user_id = ? ORDER BY id DESC`,
        [req.user.id]
      );
      const withApproval = await attachAttendanceCorrectionApproval(rows.map((r: any) => ({ ...r, has_file: !!r.has_file })));
      res.json(withApproval);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download/preview the attachment on an Attendance Correction request — the
  // owner themself, or an Admin with the "attendance" or "approvals" module,
  // may fetch it.
  app.get("/api/attendance/corrections/:id/file", authenticateToken, async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM attendance_corrections WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Correction request not found" });
      const c = rows[0];
      const isOwner = Number(c.user_id) === Number(req.user.id);
      if (!isOwner) {
        if (req.user.role !== "superadmin") {
          if (req.user.role !== "admin") return res.status(403).json({ error: "Not authorized" });
          const modules = await getAdminModules(req.user.id);
          if (!modules.includes("attendance") && !modules.includes("approvals")) return res.status(403).json({ error: "Not authorized" });
        }
      }
      if (!c.file_data) return res.status(404).json({ error: "No attachment on this request" });
      const buffer: Buffer = Buffer.isBuffer(c.file_data) ? c.file_data : Buffer.from(c.file_data);
      res.setHeader("Content-Type", c.file_mimetype || "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(c.file_name || `attendance_correction_${c.id}`)}"`);
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Legacy single-step Admin Approve/Reject on a Pending Attendance Correction —
  // only usable when NO Approval Chain is configured (in that case POST
  // /api/attendance/corrections already auto-processed the request immediately)
  // OR as a Superadmin override for a request that somehow has no Approval
  // Request tracking it. Once a chain exists, new requests route through POST
  // /api/approvals/:id/act instead — this route refuses to touch a request that
  // already has an Approval Request in flight, so the two paths can never
  // double-process the same request.
  app.post("/api/attendance/corrections/:id/decision", authenticateToken, requireAdmin, requireModule("attendance"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM attendance_corrections WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Correction request not found" });
      const c = rows[0];
      if (c.status !== "pending") return res.status(400).json({ error: "This request has already been reviewed." });

      const existingRequest = await queryDB("SELECT id FROM approval_requests WHERE source_type = 'attendance_correction' AND source_id = ?", [
        c.id
      ]);
      if (existingRequest.length > 0) {
        return res.status(400).json({ error: "This request is going through the Approval Workflow — act on it from the Approvals tab instead." });
      }

      const { action, remarks } = req.body || {};
      const trimmedRemarks = typeof remarks === "string" ? remarks.trim().slice(0, 1000) : null;

      if (action === "reject") {
        if (!trimmedRemarks) return res.status(400).json({ error: "Please give a reason so the User understands why." });
        await rejectAttendanceCorrection(c.id, req.user.id, trimmedRemarks);
        return res.json({ success: true, status: "rejected" });
      }
      if (action !== "approve") return res.status(400).json({ error: "action must be 'approve' or 'reject'" });

      await finalizeAttendanceCorrection(c.id, req.user.id, trimmedRemarks);
      res.json({ success: true, status: "approved" });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to record the decision" });
    }
  });

  // System-wide attendance list for the Superadmin's (or a granted Admin's) Remote
  // Attendance tab — every User, every Project, filterable by project/user/date.
  app.get("/api/attendance", authenticateToken, requireAdmin, requireModule("attendance"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM attendance");
      const projects = await queryDB("SELECT * FROM projects");
      const users = await queryDB("SELECT id, name, email, role, created_at FROM users");
      const projectMap = new Map<number, any>(projects.map((p: any) => [p.id, p]));
      const userMap = new Map<number, any>(users.map((u: any) => [u.id, u]));

      const project_id = req.query.project_id ? Number(req.query.project_id) : null;
      const user_id = req.query.user_id ? Number(req.query.user_id) : null;
      const from = req.query.from ? String(req.query.from) : null;
      const to = req.query.to ? String(req.query.to) : null;

      const filtered = rows.filter((r: any) => {
        if (project_id && Number(r.project_id) !== project_id) return false;
        if (user_id && Number(r.user_id) !== user_id) return false;
        if (from && r.attendance_date < from) return false;
        if (to && r.attendance_date > to) return false;
        return true;
      });

      filtered.sort((a: any, b: any) => (a.attendance_date < b.attendance_date ? 1 : a.attendance_date > b.attendance_date ? -1 : b.id - a.id));

      const withApprovals = await attachApprovalStatuses("attendance", filtered.slice(0, 1000));
      res.json(
        withApprovals.map((r: any) => {
          const proj = projectMap.get(r.project_id);
          const u = userMap.get(r.user_id);
          return {
            ...r,
            project_name: proj?.project_name || null,
            location_radius: proj?.location_radius ?? null,
            user_name: u?.name || null
          };
        })
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Monthly Attendance Report — Month Wise (Admin Panel -> Monthly Attendance
  // Report). Gated by its own 'attendance_reports' module (separate from the
  // raw 'attendance' log module above) so a Superadmin can grant just this
  // summary report — to an Admin OR a plain User account — without exposing
  // the full check-in/out log. Reuses the same already-mocked SELECT * FROM
  // attendance / projects / users queries and does the day-by-day rollup in
  // JS, so no new mock-DB branches are needed.
  // Distinct Department list for the Monthly Attendance Report's Department
  // filter dropdown — gated by 'attendance_reports' (not 'employees' or the
  // newer 'departments' module), since this report module can be granted to
  // an account that has no access to the Employee Directory or Departments
  // tabs at all. Reads the plain-text `department` mirror column (kept in
  // sync with the structured Department by resolveEmployeeDepartment) rather
  // than the `departments` table itself, so this still works for any legacy
  // row that was never migrated onto a structured Department. Only
  // departments actually linked to a login account are useful here (a
  // Department with no linked User can never appear in the report anyway).
  app.get("/api/attendance/report/departments", authenticateToken, requireAdmin, requireModule("attendance_reports"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT DISTINCT department FROM all_employees WHERE user_id IS NOT NULL AND department IS NOT NULL AND department <> ''");
      let departments = rows.map((r: any) => r.department).sort((a: string, b: string) => a.localeCompare(b));

      // Department-wise scope (see the deps comment above) — a Superadmin, or
      // an Admin/User with no scope rows at all, keeps seeing every
      // Department exactly as before; a scoped account's filter dropdown
      // only ever offers the Department(s) they've actually been granted.
      if (req.user.role !== "superadmin") {
        const scope = await getAttendanceReportDeptScope(req.user.id);
        if (scope) {
          const allowed = new Set(scope);
          departments = departments.filter((d: string) => allowed.has(d));
        }
      }

      res.json(departments);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/attendance/report/monthly", authenticateToken, requireAdmin, requireModule("attendance_reports"), async (req: any, res) => {
    try {
      const year = Number(req.query.year);
      const month = Number(req.query.month); // 1-12
      if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
        return res.status(400).json({ error: "A valid year and month (1-12) are required." });
      }
      const project_id = req.query.project_id ? Number(req.query.project_id) : null;
      const user_id = req.query.user_id ? Number(req.query.user_id) : null;
      const department = req.query.department ? String(req.query.department).trim() : null;

      // Department-wise scope (see the deps comment above). null = unrestricted.
      // A department query param outside the caller's scope is rejected up
      // front (400) rather than silently returning an empty/wrong report —
      // this only ever fires for a scoped Admin/User deliberately typing
      // another Department into the request, since the UI's own dropdown
      // (GET /api/attendance/report/departments) already only offers
      // Departments they're allowed to see.
      const deptScope = req.user.role === "superadmin" ? null : await getAttendanceReportDeptScope(req.user.id);
      if (deptScope && department && !deptScope.includes(department)) {
        return res.status(403).json({ error: "You don't have access to this Department's Attendance Report." });
      }

      const rows = await queryDB("SELECT * FROM attendance");
      const projects = await queryDB("SELECT * FROM projects");
      const users = await queryDB("SELECT id, name, email, role, created_at FROM users");
      const projectMap = new Map<number, any>(projects.map((p: any) => [p.id, p]));

      const monthStr = String(month).padStart(2, "0");
      const prefix = `${year}-${monthStr}`;
      const daysInMonth = new Date(year, month, 0).getDate();
      const monthStart = `${prefix}-01`;
      const monthEnd = `${prefix}-${String(daysInMonth).padStart(2, "0")}`;

      // Department comes from the Employee Directory row linked to this login
      // account (all_employees.user_id) — no department column of its own on
      // users, same lookup pattern GET /api/leave-balances uses. This is the
      // plain-text `department` mirror, kept in sync with the structured
      // Department (Admin Panel -> Departments) by resolveEmployeeDepartment,
      // so it stays correct whether that row was set via the Department
      // dropdown or (on an older row) never migrated off free text.
      const allEmployeesForDept = await queryDB("SELECT user_id, department FROM all_employees WHERE user_id IS NOT NULL");
      const departmentByUserId = new Map<number, string>();
      for (const e of allEmployeesForDept) {
        if (e.user_id != null && e.department) departmentByUserId.set(Number(e.user_id), e.department);
      }

      const relevantUsers = users.filter(
        (u: any) =>
          (u.role === "user" || u.role === "admin") &&
          (!user_id || u.id === user_id) &&
          (!department || departmentByUserId.get(u.id) === department) &&
          // Department-wise scope, unfiltered-request case: `department` was
          // already validated to be within deptScope above when given, so
          // this only bites when the caller left the Department filter blank
          // (wants "all Departments") but is actually scoped to a subset —
          // narrow silently to their allowed Department(s) rather than
          // erroring, same as leaving any other filter blank means "don't
          // filter on this", not "you must pick one".
          (!deptScope || deptScope.includes(departmentByUserId.get(u.id) || ""))
      );

      // Global Calendar (Admin Panel -> Holidays) — any date the Superadmin (or
      // whoever's been granted the "holidays" module) has marked Weekend or
      // Holiday here is excluded from absent_days below entirely, whether or
      // not the person actually checked in that day.
      const holidayMap = await getHolidayMap(queryDB, monthStart, monthEnd);

      const byUser = new Map<number, Map<string, any>>();
      for (const r of rows) {
        const dateStr = String(r.attendance_date).slice(0, 10);
        if (!dateStr.startsWith(prefix)) continue;
        if (project_id && Number(r.project_id) !== project_id) continue;
        if (!byUser.has(r.user_id)) byUser.set(r.user_id, new Map());
        byUser.get(r.user_id)!.set(dateStr, r);
      }

      // Office Attendance (ZKTeco) fallback — used ONLY to fill in a day/user
      // that has NO Remote (GPS) attendance row at all. Remote Attendance above
      // is never touched or overridden by this; it's purely a gap-filler so a
      // user who skipped the GPS check-in but did punch the office biometric
      // device isn't wrongly counted Absent. Skipped entirely when filtering by
      // project_id, since Office Attendance has no project of its own.
      const officeByUserDate = new Map<string, any>();
      if (!project_id) {
        const employees = await queryDB(
          "SELECT user_id, zk_device_pin FROM all_employees WHERE user_id IS NOT NULL AND zk_device_pin IS NOT NULL"
        );
        const pinByUserId = new Map<number, string>(employees.map((e: any) => [e.user_id, e.zk_device_pin]));
        if (pinByUserId.size > 0) {
          const officeLogs = await queryDB(
            // Same single-punch guard — a day with exactly one punch (e.g.
            // today, before the person has punched Out) must report
            // check_out_at as NULL, not the same timestamp as check_in_at.
            `SELECT device_user_pin, DATE(punch_time) AS attendance_date,
                    MIN(punch_time) AS check_in_at,
                    CASE WHEN COUNT(*) > 1 THEN MAX(punch_time) ELSE NULL END AS check_out_at
             FROM zk_attendance_logs
             WHERE DATE(punch_time) BETWEEN ? AND ?
             GROUP BY device_user_pin, DATE(punch_time)`,
            [monthStart, monthEnd]
          );
          const officeByPinDate = new Map<string, any>();
          for (const o of officeLogs) {
            officeByPinDate.set(`${o.device_user_pin}|${String(o.attendance_date).slice(0, 10)}`, o);
          }
          for (const [userId, pin] of pinByUserId) {
            for (let d = 1; d <= daysInMonth; d++) {
              const dateStr = `${prefix}-${String(d).padStart(2, "0")}`;
              const o = officeByPinDate.get(`${pin}|${dateStr}`);
              if (o) officeByUserDate.set(`${userId}|${dateStr}`, o);
            }
          }
        }
      }

      const result = relevantUsers.map((u: any) => {
        const dayMap = byUser.get(u.id) || new Map<string, any>();
        let presentDays = 0;
        let completeDays = 0;
        let holidayDays = 0;
        let absentDays = 0;
        const days: any[] = [];
        for (let d = 1; d <= daysInMonth; d++) {
          const dateStr = `${prefix}-${String(d).padStart(2, "0")}`;
          const rec: any = dayMap.get(dateStr);
          let hasIn = !!rec?.check_in_at;
          let hasOut = !!rec?.check_out_at;
          let checkInAt = rec?.check_in_at || null;
          let checkOutAt = rec?.check_out_at || null;
          let projectName = rec ? (projectMap.get(rec.project_id)?.project_name || null) : null;
          let source: "remote" | "office" | null = rec ? "remote" : null;
          // Remote (GPS) check-in/out remarks — Office (ZKTeco) punches carry
          // no remarks field at all, so this stays null on an office-sourced day.
          let checkInRemarks: string | null = rec?.check_in_remarks || null;
          let checkOutRemarks: string | null = rec?.check_out_remarks || null;

          // Fallback: no Remote attendance this day -> use Office Attendance if it exists.
          if (!rec) {
            const office = officeByUserDate.get(`${u.id}|${dateStr}`);
            if (office) {
              hasIn = true;
              hasOut = !!office.check_out_at;
              checkInAt = office.check_in_at;
              checkOutAt = office.check_out_at;
              projectName = null;
              source = "office";
            }
          }

          // Global Calendar (Weekend/Holiday) — a date set here counts toward
          // neither presentDays nor absent_days below, even when the person
          // didn't check in; it's not a normal working day at all.
          const holiday = holidayMap.get(dateStr);
          if (holiday) holidayDays++;
          else if (!hasIn) absentDays++;

          if (hasIn) presentDays++;
          if (hasIn && hasOut) completeDays++;
          days.push({
            date: dateStr,
            present: hasIn,
            check_in_at: checkInAt,
            check_out_at: checkOutAt,
            project_name: projectName,
            source,
            check_in_remarks: checkInRemarks,
            check_out_remarks: checkOutRemarks,
            day_type: holiday ? holiday.day_type : null,
            holiday_title: holiday ? holiday.title : null
          });
        }
        return {
          user_id: u.id,
          user_name: u.name,
          user_role: u.role,
          department: departmentByUserId.get(u.id) || null,
          present_days: presentDays,
          complete_days: completeDays,
          holiday_days: holidayDays,
          absent_days: absentDays,
          days
        };
      });

      result.sort((a: any, b: any) => a.user_name.localeCompare(b.user_name));
      res.json({ year, month, days_in_month: daysInMonth, users: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Monthly Attendance Report — Date Wise (same 'attendance_reports' module):
  // one specific calendar day, split into who checked in/out that day vs. who
  // didn't (Present / Absent), across every User/Admin account.
  app.get("/api/attendance/report/daily", authenticateToken, requireAdmin, requireModule("attendance_reports"), async (req: any, res) => {
    try {
      const date = String(req.query.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "A valid date (YYYY-MM-DD) is required." });
      }
      const project_id = req.query.project_id ? Number(req.query.project_id) : null;
      const user_id = req.query.user_id ? Number(req.query.user_id) : null;
      const department = req.query.department ? String(req.query.department).trim() : null;

      // Department-wise scope (see the deps comment above / the monthly
      // report route's own copy of this check). null = unrestricted.
      const deptScope = req.user.role === "superadmin" ? null : await getAttendanceReportDeptScope(req.user.id);
      if (deptScope && department && !deptScope.includes(department)) {
        return res.status(403).json({ error: "You don't have access to this Department's Attendance Report." });
      }

      const rows = await queryDB("SELECT * FROM attendance");
      const projects = await queryDB("SELECT * FROM projects");
      const users = await queryDB("SELECT id, name, email, role, created_at FROM users");
      const projectMap = new Map<number, any>(projects.map((p: any) => [p.id, p]));

      // Same Employee Directory lookup GET /api/attendance/report/monthly and
      // GET /api/leave-balances use — department has no column of its own on users.
      const allEmployeesForDept = await queryDB("SELECT user_id, department FROM all_employees WHERE user_id IS NOT NULL");
      const departmentByUserId = new Map<number, string>();
      for (const e of allEmployeesForDept) {
        if (e.user_id != null && e.department) departmentByUserId.set(Number(e.user_id), e.department);
      }

      const dayRows = rows.filter(
        (r: any) => String(r.attendance_date).slice(0, 10) === date && (!project_id || Number(r.project_id) === project_id)
      );
      const withApprovals = await attachApprovalStatuses("attendance", dayRows);
      const byUserId = new Map<number, any>(withApprovals.map((r: any) => [r.user_id, r]));

      const relevantUsers = users.filter(
        (u: any) =>
          (u.role === "user" || u.role === "admin") &&
          (!user_id || u.id === user_id) &&
          (!department || departmentByUserId.get(u.id) === department) &&
          // Department-wise scope, unfiltered-request case — see the monthly
          // report route's identical comment above.
          (!deptScope || deptScope.includes(departmentByUserId.get(u.id) || ""))
      );

      // Office Attendance (ZKTeco) fallback — only for users with NO Remote (GPS)
      // row on this date. Remote Attendance rows above are never overridden.
      // Skipped when filtering by project_id, since Office Attendance has none.
      const officeByUserId = new Map<number, any>();
      if (!project_id) {
        const officeRows = await queryDB(
          // Same single-punch guard — see the other zk_attendance_logs
          // queries above.
          `SELECT e.user_id, MIN(l.punch_time) AS check_in_at,
                  CASE WHEN COUNT(*) > 1 THEN MAX(l.punch_time) ELSE NULL END AS check_out_at
           FROM zk_attendance_logs l
           JOIN all_employees e ON e.zk_device_pin = l.device_user_pin
           WHERE DATE(l.punch_time) = ? AND e.user_id IS NOT NULL
           GROUP BY e.user_id`,
          [date]
        );
        for (const o of officeRows) officeByUserId.set(o.user_id, o);
      }

      const present = relevantUsers
        .filter((u: any) => byUserId.has(u.id) || officeByUserId.has(u.id))
        .map((u: any) => {
          const r = byUserId.get(u.id);
          if (r) {
            const proj = projectMap.get(r.project_id);
            return {
              user_id: u.id,
              user_name: u.name,
              department: departmentByUserId.get(u.id) || null,
              project_name: proj?.project_name || null,
              check_in_at: r.check_in_at || null,
              check_out_at: r.check_out_at || null,
              check_in_distance_m: r.check_in_distance_m ?? null,
              check_out_distance_m: r.check_out_distance_m ?? null,
              check_in_remarks: r.check_in_remarks || null,
              check_out_remarks: r.check_out_remarks || null,
              check_in_approval: r.check_in_approval || null,
              check_out_approval: r.check_out_approval || null,
              source: "remote"
            };
          }
          const o = officeByUserId.get(u.id);
          return {
            user_id: u.id,
            user_name: u.name,
            department: departmentByUserId.get(u.id) || null,
            project_name: null,
            check_in_at: o.check_in_at || null,
            check_out_at: o.check_out_at || null,
            check_in_distance_m: null,
            check_out_distance_m: null,
            check_in_remarks: null,
            check_out_remarks: null,
            check_in_approval: null,
            check_out_approval: null,
            source: "office"
          };
        });
      // Global Calendar (Admin Panel -> Holidays) — if this date itself is a
      // Weekend/Holiday, nobody who didn't check in is counted Absent for it;
      // they're just reported separately as on_holiday.
      const holidayMap = await getHolidayMap(queryDB, date, date);
      const holidayToday = holidayMap.get(date) || null;

      const presentIds = new Set(present.map((p: any) => p.user_id));
      const absent = holidayToday
        ? []
        : relevantUsers
            .filter((u: any) => !presentIds.has(u.id))
            .map((u: any) => ({ user_id: u.id, user_name: u.name, department: departmentByUserId.get(u.id) || null }));
      const onHoliday = holidayToday
        ? relevantUsers
            .filter((u: any) => !presentIds.has(u.id))
            .map((u: any) => ({ user_id: u.id, user_name: u.name, department: departmentByUserId.get(u.id) || null }))
        : [];

      present.sort((a: any, b: any) => a.user_name.localeCompare(b.user_name));
      absent.sort((a: any, b: any) => a.user_name.localeCompare(b.user_name));
      onHoliday.sort((a: any, b: any) => a.user_name.localeCompare(b.user_name));

      res.json({
        date,
        present,
        absent,
        on_holiday: onHoliday,
        day_type: holidayToday?.day_type || null,
        holiday_title: holidayToday?.title || null,
        total_users: relevantUsers.length
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
