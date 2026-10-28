/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Forgot password — "Forgot password?" is always on the login page, with the
// ways back in a Superadmin leaves on (password_reset_settings; until one is
// saved, "Ask HR" is on and "Email code" off — it needs SMTP):
//
//   Email code   "Forgot password?" on the login page -> Login ID -> a 6-digit
//                code goes to the account's email (15 minutes, 5 tries) ->
//                code + new password. Needs SMTP (mailer.ts).
//   Ask HR       "Forgot password?" -> Login ID (+ a note) -> the request waits
//                in Admin Panel -> Users -> Password requests; whoever handles
//                it gets a one-time temporary password to pass on, and the
//                account must set its own at the next sign-in
//                (users.must_change_password).
//
// Either way every earlier sign-in of the account ends. The public routes
// answer the same whether or not the Login ID exists (no one can find out who
// has an account), and are rate-limited per IP and per account
// (password_reset_log). A Superadmin's password comes from .env, a blocked
// account stays blocked, so neither can use this.
//
// Access: Users module layer "password_requests" (explicit-only) sees and
// handles the requests; a Superadmin always, and only a Superadmin changes
// the settings. A handler who isn't a Superadmin resets "user" accounts only.

import { clearLoginLock } from "./LoginGuard";
import type { Express } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { sendMail, isMailerConfigured } from "./mailer";
import { endAllSessions } from "./SessionSecurity";
import { clientIp } from "./ActiveUsersRoutes";
import { passwordProblem } from "./src/lib/passwordPolicy";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireSuperAdmin: any;
  requireModuleLayer: (moduleKey: any, layer: any) => any;
  queryDB: QueryDB;
  secret: string;
  createAlert: (queryDB: QueryDB, params: { userId: number; type: any; title: string; message: string; relatedType?: string; relatedId?: number }) => Promise<void>;
}

export async function ensurePasswordResetSchema(dbPool: any): Promise<void> {
  const run = async (label: string, sql: string) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      console.warn(`⚠️ Forgot password (${label}): ${err.message}`);
    }
  };
  await run(
    "password_reset_settings",
    `CREATE TABLE IF NOT EXISTS password_reset_settings (
      id INT PRIMARY KEY,
      email_code_enabled TINYINT(1) NOT NULL DEFAULT 0,
      hr_request_enabled TINYINT(1) NOT NULL DEFAULT 1,
      updated_by INT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`
  );
  await run(
    "password_reset_codes",
    `CREATE TABLE IF NOT EXISTS password_reset_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      code_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      used_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_prc_user (user_id, created_at),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
  await run(
    "password_reset_requests",
    `CREATE TABLE IF NOT EXISTS password_reset_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      note VARCHAR(255) NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'pending',
      ip VARCHAR(64) NULL,
      handled_by INT NULL,
      handled_at DATETIME NULL,
      reject_reason VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_prr_status (status, created_at),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
  await run(
    "password_reset_log",
    `CREATE TABLE IF NOT EXISTS password_reset_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ip VARCHAR(64) NULL,
      kind VARCHAR(12) NOT NULL,
      user_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_prl (kind, created_at)
    )`
  );
}

const WINDOW_MIN = 15;
// Per IP per 15 minutes / per account per 15 minutes.
const LIMITS: Record<string, { ip: number; user: number }> = {
  email: { ip: 10, user: 3 },
  verify: { ip: 25, user: 10 },
  request: { ip: 10, user: 3 }
};
const CODE_MINUTES = 15;
const CODE_TRIES = 5;

const SENT_EMAIL = "If that Login ID has an email address, a 6-digit code has been sent to it. It works for 15 minutes.";
const SENT_REQUEST = "Your request has been sent to HR. They will give you a temporary password.";
const BAD_CODE = "That code is wrong or has expired. Ask for a new one.";

export function registerPasswordResetRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireAdmin, requireSuperAdmin, requireModuleLayer, queryDB, secret, createAlert } = deps;
  const canHandle = [authenticateToken, requireAdmin, requireModuleLayer("users", "password_requests")];
  const hashCode = (userId: number, code: string) => crypto.createHmac("sha256", secret).update(`${userId}:${code}`).digest("hex");

  // The last code email's outcome, for the Superadmin's settings card.
  let lastMail: { at: string; to: string | null; error: string | null } | null = null;
  const noteMailResult = (to: string | null, error: string | null) => {
    lastMail = { at: new Date().toISOString(), to: to ? to.replace(/^(.).*?(@.*)$/, "$1…$2") : null, error };
  };

  async function settings() {
    const rows: any[] = (await queryDB("/*unscoped*/ SELECT email_code_enabled, hr_request_enabled FROM password_reset_settings WHERE id = 1").catch(() => [])) || [];
    // Nothing saved yet: "Ask HR" on, email codes off.
    if (!rows[0]) return { email_code_enabled: false, hr_request_enabled: true };
    return { email_code_enabled: !!Number(rows[0].email_code_enabled), hr_request_enabled: !!Number(rows[0].hr_request_enabled) };
  }

  // The account a Login ID names (same lookup as sign-in), or null.
  async function findAccount(identifierRaw: unknown) {
    return (await lookupAccount(identifierRaw)).u;
  }
  // …and why not, for the server log (the person is never told).
  async function lookupAccount(identifierRaw: unknown): Promise<{ u: any; why: string }> {
    const identifier = String(identifierRaw ?? "").trim().slice(0, 190);
    if (!identifier) return { u: null, why: "no Login ID was given" };
    const rows: any[] =
      (await queryDB("/*unscoped*/ SELECT id, name, email, username, role, is_blocked FROM users WHERE email = ? OR username = ? LIMIT 1", [
        identifier,
        identifier.replace(/\s+/g, "").toLowerCase()
      ])) || [];
    const u = rows[0];
    const why = !u
      ? "no account has this Login ID"
      : u.role === "superadmin"
        ? "it is the Superadmin (that password comes from ADMIN_PASSWORD in .env)"
        : Number(u.is_blocked || 0) === 1
          ? "the account is blocked"
          : "";
    return { u: why ? null : u, why };
  }

  // true while this IP / account is under the limit; the attempt is logged.
  async function allowed(kind: "email" | "verify" | "request", ip: string, userId: number | null) {
    const lim = LIMITS[kind];
    const [byIp]: any[] =
      (await queryDB(`/*unscoped*/ SELECT COUNT(*) AS n FROM password_reset_log WHERE kind = ? AND ip = ? AND created_at > NOW() - INTERVAL ${WINDOW_MIN} MINUTE`, [kind, ip])) || [];
    let ok = Number(byIp?.n || 0) < lim.ip;
    if (ok && userId) {
      const [byUser]: any[] =
        (await queryDB(`/*unscoped*/ SELECT COUNT(*) AS n FROM password_reset_log WHERE kind = ? AND user_id = ? AND created_at > NOW() - INTERVAL ${WINDOW_MIN} MINUTE`, [kind, userId])) || [];
      ok = Number(byUser?.n || 0) < lim.user;
    }
    await queryDB("/*unscoped*/ INSERT INTO password_reset_log (ip, kind, user_id) VALUES (?, ?, ?)", [ip, kind, userId]).catch(() => {});
    return ok;
  }
  const tooMany = (res: any) => res.status(429).json({ error: `Too many tries. Wait ${WINDOW_MIN} minutes and try again.` });

  // ---- public (login page) ----
  app.get("/api/auth/forgot/options", async (_req, res) => {
    const s = await settings();
    res.json({ email: s.email_code_enabled && isMailerConfigured(), request: s.hr_request_enabled });
  });

  app.post("/api/auth/forgot/email", async (req: any, res) => {
    try {
      const s = await settings();
      if (!s.email_code_enabled || !isMailerConfigured()) return res.status(403).json({ error: "Resetting by email isn't turned on. Ask HR." });
      const ip = clientIp(req);
      const { u, why: skipped } = await lookupAccount(req.body?.identifier);
      if (!(await allowed("email", ip, u?.id ?? null))) return tooMany(res);
      const email = String(u?.email || "").trim();
      const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!u || !hasEmail) {
        const why = skipped || "the account has no email address (ask HR instead)";
        console.log(`ℹ️ Forgot password: no code sent for "${String(req.body?.identifier || "").slice(0, 80)}" — ${why}.`);
        noteMailResult(null, why);
      }
      if (u && hasEmail) {
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
        // Only the newest code works.
        await queryDB("/*unscoped*/ UPDATE password_reset_codes SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL", [u.id]);
        await queryDB(`/*unscoped*/ INSERT INTO password_reset_codes (user_id, code_hash, expires_at) VALUES (?, ?, NOW() + INTERVAL ${CODE_MINUTES} MINUTE)`, [
          u.id,
          hashCode(u.id, code)
        ]);
        const sent = await sendMail({
          to: email,
          subject: "CredenceHR password reset code",
          html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1e293b">
            <p>Hello ${String(u.name || "").replace(/</g, "&lt;")},</p>
            <p>Your CredenceHR password reset code is:</p>
            <p style="font-size:30px;font-weight:bold;letter-spacing:6px;color:#6d28d9">${code}</p>
            <p>It works for ${CODE_MINUTES} minutes. If you didn't ask for it, ignore this email — your password stays the same.</p>
            <p style="color:#64748b">আপনার CredenceHR পাসওয়ার্ড রিসেট কোড: <b>${code}</b> (${CODE_MINUTES} মিনিট কাজ করবে)।</p>
          </div>`
        });
        if (!sent.success) console.warn(`⚠️ Password reset email to user ${u.id} (${email}) failed: ${sent.error}`);
        else console.log(`✉️ Password reset code sent to user ${u.id} (${email}).`);
        noteMailResult(email, sent.success ? null : sent.error || "failed");
      }
      res.json({ success: true, message: SENT_EMAIL });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/auth/forgot/email/verify", async (req: any, res) => {
    try {
      const s = await settings();
      if (!s.email_code_enabled) return res.status(403).json({ error: "Resetting by email isn't turned on. Ask HR." });
      const ip = clientIp(req);
      const code = String(req.body?.code || "").replace(/\D/g, "");
      const password = String(req.body?.new_password || "");
      // Checked before looking the account up, so the answer says nothing about it.
      const pwBad = passwordProblem(password);
      if (pwBad) return res.status(400).json({ error: pwBad });
      const u = await findAccount(req.body?.identifier);
      if (!(await allowed("verify", ip, u?.id ?? null))) return tooMany(res);
      if (!u || code.length !== 6) return res.status(400).json({ error: BAD_CODE });
      const rows: any[] =
        (await queryDB(
          "/*unscoped*/ SELECT id, code_hash, attempts FROM password_reset_codes WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW() ORDER BY id DESC LIMIT 1",
          [u.id]
        )) || [];
      const row = rows[0];
      if (!row || Number(row.attempts) >= CODE_TRIES) return res.status(400).json({ error: BAD_CODE });
      const good = crypto.timingSafeEqual(Buffer.from(String(row.code_hash)), Buffer.from(hashCode(u.id, code)));
      if (!good) {
        await queryDB("/*unscoped*/ UPDATE password_reset_codes SET attempts = attempts + 1 WHERE id = ?", [row.id]);
        return res.status(400).json({ error: BAD_CODE });
      }
      // Used once: the UPDATE only wins for one of two simultaneous tries.
      const r: any = await queryDB("/*unscoped*/ UPDATE password_reset_codes SET used_at = NOW() WHERE id = ? AND used_at IS NULL", [row.id]);
      if (typeof r?.affectedRows === "number" && r.affectedRows === 0) return res.status(400).json({ error: BAD_CODE });
      await queryDB("/*unscoped*/ UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", [await bcrypt.hash(password, 10), u.id]);
      await clearLoginLock(queryDB, Number(u.id));
      await endAllSessions(queryDB, Number(u.id), "password");
      res.json({ success: true, message: "Your password has been changed. Sign in with the new password." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/auth/forgot/request", async (req: any, res) => {
    try {
      const s = await settings();
      if (!s.hr_request_enabled) return res.status(403).json({ error: "Asking HR from here isn't turned on. Contact HR directly." });
      const ip = clientIp(req);
      const u = await findAccount(req.body?.identifier);
      if (!(await allowed("request", ip, u?.id ?? null))) return tooMany(res);
      if (u) {
        const note = String(req.body?.note || "").trim().slice(0, 255) || null;
        const open: any[] = (await queryDB("/*unscoped*/ SELECT id FROM password_reset_requests WHERE user_id = ? AND status = 'pending' LIMIT 1", [u.id])) || [];
        let id: number;
        if (open.length) {
          id = Number(open[0].id);
          await queryDB("/*unscoped*/ UPDATE password_reset_requests SET note = COALESCE(?, note), ip = ?, created_at = NOW() WHERE id = ?", [note, ip, id]);
        } else {
          const r: any = await queryDB("/*unscoped*/ INSERT INTO password_reset_requests (user_id, note, ip) VALUES (?, ?, ?)", [u.id, note, ip]);
          id = Number(r.insertId);
          for (const h of await handlers()) {
            await createAlert(queryDB, {
              userId: h,
              type: "password_request",
              title: "Password reset request",
              message: `${u.name || u.email || u.username} can't sign in and asked for a new password.`,
              relatedType: "password_request",
              relatedId: id
            }).catch(() => {});
          }
        }
      }
      res.json({ success: true, message: SENT_REQUEST });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Who hears about a new request: Superadmins and accounts with the layer.
  async function handlers(): Promise<number[]> {
    const rows: any[] =
      (await queryDB(
        `/*unscoped*/ SELECT DISTINCT u.id FROM users u
          WHERE u.role = 'superadmin'
             OR (u.role IN ('admin', 'user') AND COALESCE(u.is_blocked, 0) = 0
                 AND EXISTS (SELECT 1 FROM admin_module_permissions p WHERE p.user_id = u.id AND p.module_key = 'users')
                 AND EXISTS (SELECT 1 FROM admin_module_permission_layers l WHERE l.user_id = u.id AND l.module_key = 'users' AND l.layer_key = 'password_requests'))`
      ).catch(() => [])) || [];
    return rows.map((r) => Number(r.id));
  }

  // ---- Admin Panel -> Users -> Password requests ----
  app.get("/api/password-requests", ...canHandle, async (req: any, res) => {
    try {
      const view = req.query.view === "done" ? "done" : "pending";
      const rows: any[] =
        (await queryDB(
          `/*unscoped*/ SELECT r.id, r.user_id, r.note, r.status, r.created_at, r.handled_at, r.reject_reason,
                  u.name, u.email, u.username, u.role, h.name AS handled_by_name,
                  (SELECT e.employee_id FROM all_employees e WHERE e.user_id = u.id LIMIT 1) AS employee_code,
                  (SELECT e.department FROM all_employees e WHERE e.user_id = u.id LIMIT 1) AS department
             FROM password_reset_requests r
             JOIN users u ON u.id = r.user_id
             LEFT JOIN users h ON h.id = r.handled_by
            WHERE ${view === "pending" ? "r.status = 'pending'" : "r.status <> 'pending' AND r.handled_at > NOW() - INTERVAL 30 DAY"}
              AND u.group_id = (SELECT group_id FROM users WHERE id = ?)
            ORDER BY r.created_at ${view === "pending" ? "ASC" : "DESC"} LIMIT 200`,
          [req.user.id]
        )) || [];
      res.json({ view, rows, can_settings: req.user.role === "superadmin", settings: req.user.role === "superadmin" ? { ...(await settings()), mailer: isMailerConfigured(), last_mail: lastMail } : null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  async function pendingFor(req: any, res: any) {
    const rows: any[] =
      (await queryDB(
        "/*unscoped*/ SELECT r.id, r.user_id, u.role, u.name, u.group_id FROM password_reset_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ? AND r.status = 'pending'",
        [Number(req.params.id)]
      )) || [];
    const r = rows[0];
    const mine: any[] = (await queryDB("/*unscoped*/ SELECT group_id FROM users WHERE id = ?", [req.user.id])) || [];
    if (!r || Number(r.group_id) !== Number(mine[0]?.group_id)) {
      res.status(404).json({ error: "This request has already been handled, or wasn't found." });
      return null;
    }
    if (req.user.role !== "superadmin" && r.role !== "user") {
      res.status(403).json({ error: "Only a Superadmin can reset an Admin's password." });
      return null;
    }
    return r;
  }

  // A one-time temporary password, easy to read out (no 0/O, 1/l/I).
  const tempPassword = () => {
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ", a = "abcdefghjkmnpqrstuvwxyz", d = "23456789";
    const pick = (s: string, n: number) => Array.from({ length: n }, () => s[crypto.randomInt(0, s.length)]).join("");
    return `${pick(A, 1)}${pick(a, 3)}-${pick(d, 4)}`;
  };

  app.post("/api/password-requests/:id/reset", ...canHandle, async (req: any, res) => {
    try {
      const r = await pendingFor(req, res);
      if (!r) return;
      const done: any = await queryDB("/*unscoped*/ UPDATE password_reset_requests SET status = 'done', handled_by = ?, handled_at = NOW() WHERE id = ? AND status = 'pending'", [
        req.user.id,
        r.id
      ]);
      if (typeof done?.affectedRows === "number" && done.affectedRows === 0) return res.status(409).json({ error: "Someone else has just handled this request." });
      const temp = tempPassword();
      await queryDB("/*unscoped*/ UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?", [await bcrypt.hash(temp, 10), r.user_id]);
      await clearLoginLock(queryDB, Number(r.user_id));
      await endAllSessions(queryDB, Number(r.user_id), "password");
      await queryDB("INSERT INTO user_access_audit (target_user_id, actor_user_id, action, detail) VALUES (?, ?, 'password-request-reset', ?)", [
        r.user_id,
        req.user.id,
        JSON.stringify({ request: r.id })
      ]).catch(() => {});
      res.json({ success: true, temp_password: temp, name: r.name });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/password-requests/:id/reject", ...canHandle, async (req: any, res) => {
    try {
      const r = await pendingFor(req, res);
      if (!r) return;
      const reason = String(req.body?.reason || "").trim().slice(0, 255) || null;
      await queryDB("/*unscoped*/ UPDATE password_reset_requests SET status = 'rejected', handled_by = ?, handled_at = NOW(), reject_reason = ? WHERE id = ? AND status = 'pending'", [
        req.user.id,
        reason,
        r.id
      ]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/password-reset-settings", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const email = req.body?.email_code_enabled ? 1 : 0;
      const hr = req.body?.hr_request_enabled ? 1 : 0;
      await queryDB(
        `/*unscoped*/ INSERT INTO password_reset_settings (id, email_code_enabled, hr_request_enabled, updated_by) VALUES (1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE email_code_enabled = VALUES(email_code_enabled), hr_request_enabled = VALUES(hr_request_enabled), updated_by = VALUES(updated_by)`,
        [email, hr, req.user.id]
      );
      res.json({ ...(await settings()), mailer: isMailerConfigured(), last_mail: lastMail });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Superadmin: send a test email and see the server's real answer (wrong
  // password, port, blocked by the provider…).
  app.post("/api/password-reset-settings/test-email", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const to = String(req.body?.to || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "Give an email address to send the test to." });
      if (!isMailerConfigured()) return res.status(400).json({ error: "SMTP isn't set up: put SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS (and SMTP_FROM) in .env, then restart the server." });
      const sent = await sendMail({
        to,
        subject: "CredenceHR test email",
        html: `<p style="font-family:Arial,sans-serif">This is a test from CredenceHR. Password reset codes will reach this mailbox the same way.</p>`
      });
      if (!sent.success) return res.status(502).json({ error: `The mail server refused: ${sent.error}` });
      res.json({ success: true, message: `Sent to ${to}. If it isn't in the inbox, look in Spam.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
