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
import bcrypt from "bcryptjs";

interface ProfileRouteDeps {
  authenticateToken: any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
}

// Matches the "less than 5MB" limit stated on the Upload Photo screen.
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_PHOTO_MIME = /^image\/(jpeg|jpg|png)$/i;

export function registerProfileRoutes(app: Express, deps: ProfileRouteDeps) {
  const { authenticateToken, queryDB } = deps;

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

      let fallbackFirst = "";
      let fallbackLast = "";
      if (!detail) {
        const parts = String(req.user.name || "").trim().split(/\s+/).filter(Boolean);
        fallbackFirst = parts[0] || "";
        fallbackLast = parts.slice(1).join(" ");
      }

      res.json({
        first_name: detail ? detail.first_name || "" : fallbackFirst,
        last_name: detail ? detail.last_name || "" : fallbackLast,
        date_of_birth: detail?.date_of_birth || null,
        country: detail?.country || null,
        state: detail?.state || null,
        city: detail?.city || null,
        full_address: detail?.full_address || null,
        has_photo: !!(detail && Number(detail.has_photo)),
        position: emp?.designation || null,
        department: emp?.department || null
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
      if (!lastName) return res.status(400).json({ error: "Last Name is required." });

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
  // LONGBLOB pattern already used for Conveyance Bill Claim attachments
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

      const existing = await queryDB("SELECT user_id FROM user_profile_details WHERE user_id = ?", [userId]);
      if (existing.length > 0) {
        await queryDB("UPDATE user_profile_details SET photo_mimetype = ?, photo_data = ? WHERE user_id = ?", [
          mimetype,
          buffer,
          userId
        ]);
      } else {
        await queryDB(
          "INSERT INTO user_profile_details (user_id, photo_mimetype, photo_data) VALUES (?, ?, ?)",
          [userId, mimetype, buffer]
        );
      }
      res.json({ success: true });
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
      if (!row || !row.photo_data) return res.status(404).json({ error: "No photo on file." });
      const buffer: Buffer = Buffer.isBuffer(row.photo_data) ? row.photo_data : Buffer.from(row.photo_data);
      res.setHeader("Content-Type", row.photo_mimetype || "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=300");
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
      if (newPassword.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters." });

      const rows = await queryDB("SELECT password_hash FROM users WHERE id = ?", [userId]);
      if (rows.length === 0) return res.status(404).json({ error: "User not found." });

      const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
      if (!valid) return res.status(400).json({ error: "Current password is incorrect." });

      const password_hash = await bcrypt.hash(newPassword, 10);
      await queryDB("UPDATE users SET password_hash = ? WHERE id = ?", [password_hash, userId]);
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