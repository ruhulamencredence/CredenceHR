/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Personal Data (ProfilePage.tsx -> PersonalDataForm.tsx) routes, split out of
// server.ts on purpose — server.ts is already ~8,400 lines in one file, so new
// features go in their own module like this from here on instead of growing
// it further. Registered from inside startServer() via registerProfileRoutes(),
// reusing that same request's `app`/`authenticateToken`/`queryDB` rather than
// creating a second Express app or a second DB connection.
//
// Deliberately only stores what nothing else already has: First Name, Last
// Name, Date of Birth, Country/State/City/Full Address, and a profile Photo,
// in a new one-row-per-user `user_profile_details` table (migration added to
// ensureSchemaMigrations() in server.ts, and to schema.sql for fresh
// installs). Position and Department are NOT duplicated here — GET below
// reads them live from the linked `all_employees` row (via
// all_employees.user_id, the same link the Employees module already
// maintains) so they always match the Employees module and there's no second
// copy that can drift out of sync. An account with no linked Employee row
// (all_employees.user_id) just gets position/department: null, which the
// client renders as "Not linked to an Employee record".

import type { Express } from "express";
import { endAllSessions, sessionKeyOf } from "./SessionSecurity";
import bcrypt from "bcryptjs";
import { passwordProblem } from "./src/lib/passwordPolicy";
import { createAlert } from "./Alerts";

interface ProfileRouteDeps {
  authenticateToken: any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
}

// Matches the "less than 5MB" limit stated on the Upload Photo screen.
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_PHOTO_MIME = /^image\/(jpeg|jpg|png)$/i;

// A new profile photo needs the Superadmin's OK: everyone else's upload waits
// here (status 'pending') while the old photo stays; Approve copies it into
// user_profile_details, Reject keeps the old one (with a reason). A newer
// upload replaces a pending one. A Superadmin's own photo, and a joiner's
// during onboarding (HR reviews the whole onboarding), go straight in.
export async function ensureProfilePhotoRequestSchema(dbPool: any) {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS profile_photo_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        photo_mimetype VARCHAR(150) NULL,
        photo_data LONGBLOB NULL,
        status ENUM('pending', 'approved', 'rejected', 'cancelled') NOT NULL DEFAULT 'pending',
        decided_by INT NULL,
        decided_at TIMESTAMP NULL DEFAULT NULL,
        reject_reason VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ppr_user (user_id, status),
        INDEX idx_ppr_status (status, created_at),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure profile_photo_requests table exists: " + err.message);
  }
}

export function registerProfileRoutes(app: Express, deps: ProfileRouteDeps) {
  const { authenticateToken, queryDB } = deps;

  const isSuper = (req: any) => req.user?.role === "superadmin" && !req.user?.onb;
  const superOnly = (req: any, res: any, next: any) => (isSuper(req) ? next() : res.status(403).json({ error: "Only the Superadmin approves profile photos." }));
  // Writes (or replaces) the live profile photo.
  async function savePhoto(userId: number, mimetype: string, buffer: Buffer) {
    const existing = await queryDB("SELECT user_id FROM user_profile_details WHERE user_id = ?", [userId]);
    if (existing.length > 0) {
      await queryDB("UPDATE user_profile_details SET photo_mimetype = ?, photo_data = ? WHERE user_id = ?", [mimetype, buffer, userId]);
    } else {
      await queryDB("INSERT INTO user_profile_details (user_id, photo_mimetype, photo_data) VALUES (?, ?, ?)", [userId, mimetype, buffer]);
    }
  }
  // This account's own waiting photo and its last refusal (for the profile page).
  async function ownPhotoState(userId: number) {
    const rows: any[] =
      (await queryDB(
        `SELECT id, status, created_at, decided_at, reject_reason FROM profile_photo_requests
          WHERE user_id = ? AND status IN ('pending', 'rejected') ORDER BY id DESC LIMIT 1`,
        [userId]
      ).catch(() => [])) || [];
    const r = rows[0];
    return {
      photo_pending: r?.status === "pending" ? { id: Number(r.id), requested_at: r.created_at } : null,
      photo_rejected: r?.status === "rejected" ? { reason: r.reject_reason || null, decided_at: r.decided_at } : null
    };
  }

  // GET /api/profile/personal-data — everything the Personal Data screen
  // needs in one call. When no user_profile_details row exists yet (never
  // saved before), first/last name fall back to splitting the account's
  // current `name` on the first space, so the form opens pre-filled instead
  // of blank on first use.
  app.get("/api/profile/personal-data", authenticateToken, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const detailRows = await queryDB(
        `SELECT first_name, last_name, date_of_birth, country, state, city, full_address,
                (photo_data IS NOT NULL) AS has_photo
           FROM user_profile_details WHERE user_id = ?`,
        [userId]
      );
      const detail = detailRows[0] || null;

      const empRows = await queryDB(
        "SELECT designation, department FROM all_employees WHERE user_id = ? LIMIT 1",
        [userId]
      );
      const emp = empRows[0] || null;

      // A row created by a photo upload alone has NULL names, so fall back
      // per field rather than only when no row exists yet.
      let fallbackFirst = "";
      let fallbackLast = "";
      if (!detail || detail.first_name == null) {
        const parts = String(req.user.name || "").trim().split(/\s+/).filter(Boolean);
        fallbackFirst = parts[0] || "";
        fallbackLast = parts.slice(1).join(" ");
      }

      res.json({
        first_name: detail?.first_name != null ? detail.first_name : fallbackFirst,
        last_name: detail?.first_name != null ? detail.last_name || "" : fallbackLast,
        date_of_birth: detail?.date_of_birth || null,
        country: detail?.country || null,
        state: detail?.state || null,
        city: detail?.city || null,
        full_address: detail?.full_address || null,
        has_photo: !!(detail && Number(detail.has_photo)),
        position: emp?.designation || null,
        department: emp?.department || null,
        // Whether a new photo waits for the Superadmin (not for the Superadmin
        // themself, nor a joiner during onboarding) — the page shows the photo
        // rules first when it does.
        photo_needs_approval: !(isSuper(req) || req.user.onb),
        ...(await ownPhotoState(userId))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/profile/personal-data — saves First/Last Name + Date of Birth +
  // Address. Position/Department are intentionally not accepted here — they
  // only ever change via the Employees module (Admin Panel -> Employees),
  // which is the single source of truth for both. Also keeps `users.name`
  // (shown everywhere else — Navbar, GlobalSidebar, etc.) in sync with the
  // First/Last Name saved here, so the two can never show a different name.
  app.put("/api/profile/personal-data", authenticateToken, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { first_name, last_name, date_of_birth, country, state, city, full_address } = req.body || {};

      const firstName = String(first_name || "").trim();
      const lastName = String(last_name || "").trim();
      if (!firstName) return res.status(400).json({ error: "First Name is required." });

      const existing = await queryDB("SELECT user_id FROM user_profile_details WHERE user_id = ?", [userId]);
      if (existing.length > 0) {
        await queryDB(
          `UPDATE user_profile_details
              SET first_name = ?, last_name = ?, date_of_birth = ?, country = ?, state = ?, city = ?, full_address = ?
            WHERE user_id = ?`,
          [firstName, lastName, date_of_birth || null, country || null, state || null, city || null, full_address || null, userId]
        );
      } else {
        await queryDB(
          `INSERT INTO user_profile_details
             (user_id, first_name, last_name, date_of_birth, country, state, city, full_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [userId, firstName, lastName, date_of_birth || null, country || null, state || null, city || null, full_address || null]
        );
      }

      const fullName = `${firstName} ${lastName}`.trim();
      await queryDB("UPDATE users SET name = ? WHERE id = ?", [fullName, userId]);

      res.json({ success: true, name: fullName });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/profile/photo — base64 upload, same FileReader/Base64 ->
  // LONGBLOB pattern already used for Bill Claim attachments
  // (user_claims.file_data) and Attendance Correction attachments — no
  // multipart/multer anywhere else in this app, so this doesn't introduce a
  // second upload mechanism.
  app.post("/api/profile/photo", authenticateToken, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { photo_base64, photo_mimetype } = req.body || {};
      if (!photo_base64 || typeof photo_base64 !== "string") {
        return res.status(400).json({ error: "No photo provided." });
      }
      const mimetype = String(photo_mimetype || "");
      if (!ALLOWED_PHOTO_MIME.test(mimetype)) {
        return res.status(400).json({ error: "Photo must be a JPEG or PNG image." });
      }
      const buffer = Buffer.from(photo_base64, "base64");
      if (buffer.length === 0) return res.status(400).json({ error: "No photo provided." });
      if (buffer.length > MAX_PHOTO_BYTES) {
        return res.status(400).json({ error: "Photo must be less than 5MB." });
      }

      // The Superadmin's own photo, and a joiner's during onboarding, go straight in.
      if (isSuper(req) || req.user.onb) {
        await savePhoto(userId, mimetype, buffer);
        return res.json({ success: true, applied: true });
      }
      // Anyone else's waits for the Superadmin; a newer upload replaces a waiting one.
      const waiting: any[] = (await queryDB("SELECT id FROM profile_photo_requests WHERE user_id = ? AND status = 'pending' ORDER BY id DESC", [userId])) || [];
      let id = waiting[0] ? Number(waiting[0].id) : 0;
      if (id) {
        await queryDB("UPDATE profile_photo_requests SET photo_mimetype = ?, photo_data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?", [mimetype, buffer, id]);
        if (waiting.length > 1) await queryDB(`UPDATE profile_photo_requests SET status = 'cancelled', photo_data = NULL WHERE id IN (${waiting.slice(1).map(() => "?").join(",")})`, waiting.slice(1).map((w) => Number(w.id)));
      } else {
        const r: any = await queryDB("INSERT INTO profile_photo_requests (user_id, photo_mimetype, photo_data) VALUES (?, ?, ?)", [userId, mimetype, buffer]);
        id = Number(r.insertId);
        const supers: any[] = (await queryDB("SELECT id FROM users WHERE role = 'superadmin' AND COALESCE(is_blocked, 0) = 0").catch(() => [])) || [];
        for (const s of supers) {
          await createAlert(queryDB, {
            userId: Number(s.id),
            type: "profile_photo",
            title: "New Profile Photo to Approve",
            message: `${req.user.name || "Someone"} uploaded a new profile photo. Approve or reject it in Admin Panel → Users → Photo approvals.`,
            relatedType: "profile_photo_request",
            relatedId: id
          }).catch(() => {});
        }
      }
      res.json({ success: true, pending: true, id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Profile photo approval ---------------------------------------------
  // The asker's own waiting photo (to show "waiting for approval") — and
  // cancelling it.
  app.get("/api/profile/photo/pending", authenticateToken, async (req: any, res) => {
    try {
      const rows: any[] = await queryDB("SELECT photo_mimetype, photo_data FROM profile_photo_requests WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", [req.user.id]);
      const row = rows[0];
      if (!row || !row.photo_data) return res.status(204).setHeader("Cache-Control", "no-store").end();
      res.setHeader("Content-Type", row.photo_mimetype || "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      res.send(Buffer.isBuffer(row.photo_data) ? row.photo_data : Buffer.from(row.photo_data));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.delete("/api/profile/photo/pending", authenticateToken, async (req: any, res) => {
    try {
      await queryDB("UPDATE profile_photo_requests SET status = 'cancelled', photo_data = NULL WHERE user_id = ? AND status = 'pending'", [req.user.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Superadmin only: the waiting photos (Admin Panel -> Users -> Photo approvals).
  app.get("/api/profile/photo-requests", authenticateToken, superOnly, async (req: any, res) => {
    try {
      const rows: any[] =
        (await queryDB(
          `SELECT r.id, r.user_id, r.created_at, u.name, u.email,
                  e.employee_id AS employee_code, e.designation, e.department,
                  (d.photo_data IS NOT NULL) AS has_current
             FROM profile_photo_requests r
             JOIN users u ON u.id = r.user_id
             LEFT JOIN all_employees e ON e.user_id = r.user_id
             LEFT JOIN user_profile_details d ON d.user_id = r.user_id
            WHERE r.status = 'pending'
            ORDER BY r.created_at ASC`
        )) || [];
      res.json(rows.map((r) => ({ ...r, id: Number(r.id), user_id: Number(r.user_id), has_current: !!Number(r.has_current) })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get("/api/profile/photo-requests/:id/image", authenticateToken, superOnly, async (req: any, res) => {
    try {
      const rows: any[] = await queryDB("SELECT photo_mimetype, photo_data FROM profile_photo_requests WHERE id = ?", [Number(req.params.id)]);
      const row = rows[0];
      if (!row || !row.photo_data) return res.status(404).json({ error: "Photo not found." });
      res.setHeader("Content-Type", row.photo_mimetype || "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      res.send(Buffer.isBuffer(row.photo_data) ? row.photo_data : Buffer.from(row.photo_data));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/profile/photo-requests/:id/:decision", authenticateToken, superOnly, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const decision = String(req.params.decision);
      if (decision !== "approve" && decision !== "reject") return res.status(404).json({ error: "Not found." });
      const rows: any[] = await queryDB("SELECT * FROM profile_photo_requests WHERE id = ?", [id]);
      const r = rows[0];
      if (!r) return res.status(404).json({ error: "Request not found." });
      if (r.status !== "pending") return res.status(409).json({ error: "This photo was already decided or replaced." });
      const reason = String(req.body?.reason || "").trim().slice(0, 255);
      if (decision === "reject" && reason.length < 3) return res.status(400).json({ error: "Write why the photo is rejected." });
      // Decided once: a second click at the same moment stops here.
      const got: any = await queryDB(
        `UPDATE profile_photo_requests SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, reject_reason = ? WHERE id = ? AND status = 'pending'`,
        [decision === "approve" ? "approved" : "rejected", req.user.id, decision === "reject" ? reason : null, id]
      );
      if (got && got.affectedRows === 0) return res.status(409).json({ error: "This photo was already decided or replaced." });
      if (decision === "approve") {
        const buffer: Buffer = Buffer.isBuffer(r.photo_data) ? r.photo_data : Buffer.from(r.photo_data || "");
        await savePhoto(Number(r.user_id), r.photo_mimetype || "image/jpeg", buffer);
      }
      // The live photo has it now (or it was refused): the copy isn't kept.
      await queryDB("UPDATE profile_photo_requests SET photo_data = NULL WHERE id = ?", [id]);
      await createAlert(queryDB, {
        userId: Number(r.user_id),
        type: "profile_photo",
        title: decision === "approve" ? "Profile Photo Approved" : "Profile Photo Not Approved",
        message: decision === "approve" ? "Your new profile photo was approved and is now shown." : `Your new profile photo was not approved: ${reason}. Your previous photo stays.`,
        relatedType: "profile_photo_decision",
        relatedId: id
      }).catch(() => {});
      res.json({ success: true, status: decision === "approve" ? "approved" : "rejected" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/profile/photo — this account's own photo. GET
  // /api/profile/photo/:userId lets any signed-in account fetch another
  // account's photo the same way — used by Self Service -> Employee
  // Directory, which is already a company-wide, every-signed-in-account
  // roster (see EmployeeDirectoryRoutes.ts), so a colleague's photo isn't
  // any more sensitive than the email/phone it already shows.
  app.get("/api/profile/photo/:userId?", authenticateToken, async (req: any, res) => {
    try {
      const targetId = req.params.userId ? Number(req.params.userId) : req.user.id;
      const rows = await queryDB(
        "SELECT photo_mimetype, photo_data FROM user_profile_details WHERE user_id = ?",
        [targetId]
      );
      const row = rows[0];
      // No photo is the normal case for most people, not an error: 204, so the
      // browser console doesn't fill with a red 404 per colleague. Callers
      // treat 204 as "show the initials".
      if (!row || !row.photo_data) return res.status(204).setHeader("Cache-Control", "no-store").end();
      const buffer: Buffer = Buffer.isBuffer(row.photo_data) ? row.photo_data : Buffer.from(row.photo_data);
      res.setHeader("Content-Type", row.photo_mimetype || "image/jpeg");
      // "/api/profile/photo" (own photo) is one URL for every account, so it is
      // never cached — on a phone shared by two people the browser handed the
      // previous account's photo back after a switch. A colleague's photo by id
      // may be kept a few minutes.
      res.setHeader("Cache-Control", req.params.userId ? "private, max-age=300" : "no-store");
      res.setHeader("Vary", "Authorization");
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/profile/password — self-service Change Password (ProfilePage ->
  // "Change Password"). Unlike the Admin's PUT /api/users/:id/reset-password
  // (UserManagement.ts, no old password needed), this is the account holder
  // changing their OWN password, so the current password must check out
  // first — same bcrypt.compare used at login.
  app.put("/api/profile/password", authenticateToken, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const currentPassword = String(req.body?.current_password || "");
      const newPassword = String(req.body?.new_password || "");
      if (!currentPassword) return res.status(400).json({ error: "Current password is required." });
      const pwBad = passwordProblem(newPassword, { email: req.user.email, name: req.user.name });
      if (pwBad) return res.status(400).json({ error: pwBad });

      const rows = await queryDB("SELECT password_hash FROM users WHERE id = ?", [userId]);
      if (rows.length === 0) return res.status(404).json({ error: "User not found." });

      const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
      if (!valid) return res.status(400).json({ error: "Current password is incorrect." });

      const password_hash = await bcrypt.hash(newPassword, 10);
      // Also clears "must change password" (a new joiner's temporary password).
      await queryDB("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", [password_hash, userId]);
      // Every other sign-in of this account ends; this one stays.
      await endAllSessions(queryDB, Number(userId), "password", sessionKeyOf(String(req.headers["authorization"] || "").split(" ")[1] || ""));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/profile/username — self-service Change Username (ProfilePage ->
  // "Change Username", only shown for accounts that log in with a Project
  // Name + Password rather than an email — see users.username in types.ts).
  // Requires the current password, same as Change Password above, since this
  // changes the credential used to log in. Login ID format matches how
  // usernames are generated on Bulk Add Users (POST /api/users/bulk,
  // UserManagement.ts): spaces stripped, lowercased.
  app.put("/api/profile/username", authenticateToken, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const currentPassword = String(req.body?.current_password || "");
      const rawUsername = String(req.body?.new_username || "").trim();
      if (!currentPassword) return res.status(400).json({ error: "Current password is required." });
      if (!rawUsername) return res.status(400).json({ error: "New username is required." });

      const newUsername = rawUsername.replace(/\s+/g, "").toLowerCase();
      if (newUsername.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters." });

      const rows = await queryDB("SELECT password_hash, username FROM users WHERE id = ?", [userId]);
      if (rows.length === 0) return res.status(404).json({ error: "User not found." });
      if (!rows[0].username) {
        return res.status(400).json({ error: "This account logs in with an email and has no username to change." });
      }

      const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
      if (!valid) return res.status(400).json({ error: "Current password is incorrect." });

      const dup = await queryDB("SELECT id FROM users WHERE username = ? AND id != ?", [newUsername, userId]);
      if (dup.length > 0) return res.status(400).json({ error: "That username is already taken." });

      await queryDB("UPDATE users SET username = ? WHERE id = ?", [newUsername, userId]);
      res.json({ success: true, username: newUsername });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}