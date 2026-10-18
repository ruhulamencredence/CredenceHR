/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Credence Mail — the mail client, inside CredenceHR (ported from the
// separate credence-mail app, without its Ollama AI; see
// docs/CREDENCE_MAIL_PLAN.md).
//
// Each CredenceHR account connects its own mailbox(es) once (IMAP to read,
// SMTP to send — cPanel credencehousinglimited.com, Gmail, Outlook, Zoho or
// any custom host). The password is kept encrypted (AES-256-GCM, key from
// MAIL_ENCRYPTION_KEY — there is no built-in key). Mail is copied into
// mail_messages by UID, folder by folder, so lists and search are fast and
// work offline from the mail server; attachments of received mail are
// fetched from the server only when opened.
//
// Access: users.can_use_mail (Self Service switch, OFF by default, Admin
// Panel -> Users -> Module Access); the Superadmin always has it. Every row
// belongs to one CredenceHR user and every query is filtered by it — nobody
// can read or send from someone else's mailbox.
//
// Scale (~1,500 staff): IMAP connections are opened only for people who are
// online (a live IDLE watcher, background-jobs worker only) or when someone
// syncs; a global cap (MAIL_MAX_IMAP, default 20) limits how many sync at
// once. New mail is announced over Socket.IO ("mail:new" to user:<id>), which
// works across PM2 workers with the Redis adapter.

import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";
import crypto from "crypto";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { runsBackgroundJobs } from "./jobRunner";
import { createAlert } from "./Alerts";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface MailDeps {
  authenticateToken: any;
  queryDB: QueryDB;
  isMySQL: () => boolean;
  // Admin Panel -> Mail Administration (module "mail_admin", server.ts).
  requireModuleLayer: (moduleKey: any, layer: any) => any;
  hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
export async function ensureMailSchema(dbPool: any): Promise<void> {
  const run = async (label: string, sql: string, ignore: string[] = []) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (!ignore.includes(err.code)) console.warn(`⚠️ Credence Mail (${label}): ${err.message}`);
    }
  };
  // Self Service switch, OFF until turned on per account in Module Access.
  await run("users.can_use_mail", "ALTER TABLE users ADD COLUMN can_use_mail TINYINT(1) NOT NULL DEFAULT 0", ["ER_DUP_FIELDNAME"]);
  const tables: [string, string][] = [
    [
      "mail_accounts",
      `CREATE TABLE IF NOT EXISTS mail_accounts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        email VARCHAR(255) NOT NULL,
        display_name VARCHAR(255) NULL,
        provider VARCHAR(40) NOT NULL DEFAULT 'custom',
        imap_host VARCHAR(255) NOT NULL,
        imap_port INT NOT NULL DEFAULT 993,
        imap_secure TINYINT(1) NOT NULL DEFAULT 1,
        smtp_host VARCHAR(255) NOT NULL,
        smtp_port INT NOT NULL DEFAULT 465,
        smtp_secure TINYINT(1) NOT NULL DEFAULT 1,
        username VARCHAR(255) NOT NULL,
        password_enc TEXT NOT NULL,
        tls_insecure TINYINT(1) NOT NULL DEFAULT 0,
        folders_json TEXT NULL,
        is_default TINYINT(1) NOT NULL DEFAULT 0,
        last_sync_at DATETIME NULL,
        last_error VARCHAR(500) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_mail_account (user_id, email),
        KEY idx_mail_account_user (user_id)
      ) DEFAULT CHARSET=utf8mb4`
    ],
    [
      "mail_folder_state",
      `CREATE TABLE IF NOT EXISTS mail_folder_state (
        account_id INT NOT NULL,
        role VARCHAR(20) NOT NULL,
        path VARCHAR(255) NOT NULL,
        uidvalidity BIGINT NOT NULL DEFAULT 0,
        last_uid BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, role)
      ) DEFAULT CHARSET=utf8mb4`
    ],
    [
      "mail_messages",
      `CREATE TABLE IF NOT EXISTS mail_messages (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        account_id INT NOT NULL,
        folder_role VARCHAR(20) NULL,
        uid BIGINT NULL,
        message_id VARCHAR(500) NULL,
        in_reply_to VARCHAR(500) NULL,
        refs TEXT NULL,
        thread_id VARCHAR(64) NOT NULL,
        from_name VARCHAR(255) NULL,
        from_email VARCHAR(255) NULL,
        to_json TEXT NULL,
        cc_json TEXT NULL,
        bcc_json TEXT NULL,
        subject TEXT NULL,
        body MEDIUMTEXT NULL,
        snippet VARCHAR(300) NULL,
        mail_date DATETIME NOT NULL,
        is_read TINYINT(1) NOT NULL DEFAULT 0,
        is_starred TINYINT(1) NOT NULL DEFAULT 0,
        is_important TINYINT(1) NOT NULL DEFAULT 0,
        labels_json TEXT NULL,
        category VARCHAR(30) NOT NULL DEFAULT 'primary',
        attachments_json TEXT NULL,
        has_attachments TINYINT(1) NOT NULL DEFAULT 0,
        scheduled_at DATETIME NULL,
        send_error VARCHAR(500) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_mail_uid (account_id, folder_role, uid),
        KEY idx_mail_list (user_id, account_id, mail_date),
        KEY idx_mail_msgid (account_id, message_id(191)),
        KEY idx_mail_scheduled (scheduled_at)
      ) DEFAULT CHARSET=utf8mb4`
    ],
    [
      "mail_files",
      `CREATE TABLE IF NOT EXISTS mail_files (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        message_id BIGINT NOT NULL,
        idx INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        mime VARCHAR(150) NULL,
        size INT NOT NULL DEFAULT 0,
        data LONGBLOB NULL,
        KEY idx_mail_files_msg (message_id)
      ) DEFAULT CHARSET=utf8mb4`
    ],
    [
      "mail_templates",
      `CREATE TABLE IF NOT EXISTS mail_templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        subject VARCHAR(500) NULL,
        body MEDIUMTEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_mail_tpl_user (user_id)
      ) DEFAULT CHARSET=utf8mb4`
    ],
    [
      "mail_filters",
      `CREATE TABLE IF NOT EXISTS mail_filters (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        conditions_json TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_mail_filter_user (user_id)
      ) DEFAULT CHARSET=utf8mb4`
    ],
    [
      "mail_tasks",
      `CREATE TABLE IF NOT EXISTS mail_tasks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(500) NOT NULL,
        due_date VARCHAR(40) NULL,
        completed TINYINT(1) NOT NULL DEFAULT 0,
        email_id BIGINT NULL,
        email_subject VARCHAR(500) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_mail_task_user (user_id)
      ) DEFAULT CHARSET=utf8mb4`
    ],
    [
      "mail_events",
      `CREATE TABLE IF NOT EXISTS mail_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(500) NOT NULL,
        start_at VARCHAR(40) NOT NULL,
        end_at VARCHAR(40) NOT NULL,
        description TEXT NULL,
        location VARCHAR(255) NULL,
        email_id BIGINT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_mail_event_user (user_id)
      ) DEFAULT CHARSET=utf8mb4`
    ],
    [
      "mail_contacts",
      `CREATE TABLE IF NOT EXISTS mail_contacts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(80) NULL,
        company VARCHAR(255) NULL,
        notes TEXT NULL,
        avatar_color VARCHAR(50) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_mail_contact_user (user_id)
      ) DEFAULT CHARSET=utf8mb4`
    ],
    [
      "mail_settings",
      `CREATE TABLE IF NOT EXISTS mail_settings (
        user_id INT PRIMARY KEY,
        signatures_json MEDIUMTEXT NULL,
        vacation_json TEXT NULL,
        blocked_json TEXT NULL,
        layout_json TEXT NULL,
        language VARCHAR(50) NULL,
        timezone VARCHAR(80) NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) DEFAULT CHARSET=utf8mb4`
    ],
    [
      "mail_signature_images",
      `CREATE TABLE IF NOT EXISTS mail_signature_images (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        token CHAR(32) NOT NULL,
        mime VARCHAR(80) NOT NULL,
        data MEDIUMBLOB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_mail_sig_user (user_id)
      ) DEFAULT CHARSET=utf8mb4`
    ],
    [
      // Admin Panel -> Mail Administration: every mailbox opened and every
      // password shown, by whom and when.
      "mail_admin_log",
      `CREATE TABLE IF NOT EXISTS mail_admin_log (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        actor_user_id INT NOT NULL,
        target_user_id INT NOT NULL,
        account_id INT NULL,
        action VARCHAR(20) NOT NULL,
        ip VARCHAR(64) NULL,
        created_at DATETIME NOT NULL,
        KEY idx_mail_admin_log_target (target_user_id, created_at),
        KEY idx_mail_admin_log_actor (actor_user_id, created_at)
      ) DEFAULT CHARSET=utf8mb4`
    ],
    [
      "mail_vacation_log",
      `CREATE TABLE IF NOT EXISTS mail_vacation_log (
        account_id INT NOT NULL,
        sender VARCHAR(255) NOT NULL,
        sent_at DATETIME NOT NULL,
        PRIMARY KEY (account_id, sender)
      ) DEFAULT CHARSET=utf8mb4`
    ]
  ];
  for (const [label, sql] of tables) await run(label, sql);
  // Internal delivery (mail between our own mailboxes stays inside
  // CredenceHR; see "Internal delivery" below): one row of settings for the
  // whole system, attachments kept once however many colleagues get them.
  await run(
    "mail_system_settings",
    `CREATE TABLE IF NOT EXISTS mail_system_settings (
      id INT PRIMARY KEY,
      internal_delivery TINYINT(1) NOT NULL DEFAULT 1,
      internal_domains VARCHAR(1000) NOT NULL DEFAULT 'credencehousinglimited.com',
      updated_by INT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) DEFAULT CHARSET=utf8mb4`
  );
  await run(
    "mail_blobs",
    `CREATE TABLE IF NOT EXISTS mail_blobs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      sha256 CHAR(64) NOT NULL,
      size INT NOT NULL DEFAULT 0,
      data LONGBLOB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mail_blob_sha (sha256)
    ) DEFAULT CHARSET=utf8mb4`
  );
  await run("mail_files.blob_id", "ALTER TABLE mail_files ADD COLUMN blob_id BIGINT NULL", ["ER_DUP_FIELDNAME"]);
  await run("mail_files.blob_id index", "ALTER TABLE mail_files ADD KEY idx_mail_files_blob (blob_id)", ["ER_DUP_KEYNAME"]);
  // 1 = this copy came / went inside CredenceHR, not through the mail server.
  // Senders whose pictures always show (no "Show pictures" each time).
  await run("mail_settings.picture_senders_json", "ALTER TABLE mail_settings ADD COLUMN picture_senders_json TEXT NULL", ["ER_DUP_FIELDNAME"]);
  await run("mail_messages.via_internal", "ALTER TABLE mail_messages ADD COLUMN via_internal TINYINT(1) NOT NULL DEFAULT 0", ["ER_DUP_FIELDNAME"]);
  // References chain, so a reply to a reply stays in the same conversation.
  await run("mail_messages.refs", "ALTER TABLE mail_messages ADD COLUMN refs TEXT NULL AFTER in_reply_to", ["ER_DUP_FIELDNAME"]);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const toDb = (d: Date | string | null | undefined): string => {
  const x = d instanceof Date ? d : d ? new Date(d) : new Date();
  return (Number.isNaN(x.getTime()) ? new Date() : x).toISOString().slice(0, 19).replace("T", " ");
};
// mail_date / scheduled_at are stored in UTC.
const fromDb = (s: any): string | null => (s ? `${String(s).slice(0, 19).replace(" ", "T")}Z` : null);
const parseJson = <T>(s: any, fallback: T): T => {
  if (s === null || s === undefined || s === "") return fallback;
  try {
    return JSON.parse(String(s)) as T;
  } catch {
    return fallback;
  }
};
const str = (v: any, max = 255) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;
const isEmail = (s: string) => EMAIL_RE.test(s);
const splitAddresses = (v: any): string[] =>
  (Array.isArray(v) ? v : String(v || "").split(/[,;]/))
    .map((x: any) => String(x || "").trim())
    .filter(Boolean)
    .map((x: string) => {
      const m = /<([^>]+)>/.exec(x);
      return (m ? m[1] : x).trim();
    })
    .filter(isEmail)
    .slice(0, 200);
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const bad = (message: string, status = 400) => Object.assign(new Error(message), { status });
const isCertError = (e: any) =>
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(e?.code) ||
  /certificate/i.test(String(e?.message || ""));

// Built-in mail settings for common providers; anything else uses the
// address's own domain for both IMAP and SMTP (the cPanel default).
const PRESETS: Record<string, { imapHost: string; imapPort: number; imapSecure: boolean; smtpHost: string; smtpPort: number; smtpSecure: boolean }> = {
  gmail: { imapHost: "imap.gmail.com", imapPort: 993, imapSecure: true, smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecure: true },
  outlook: { imapHost: "outlook.office365.com", imapPort: 993, imapSecure: true, smtpHost: "smtp.office365.com", smtpPort: 587, smtpSecure: false },
  yahoo: { imapHost: "imap.mail.yahoo.com", imapPort: 993, imapSecure: true, smtpHost: "smtp.mail.yahoo.com", smtpPort: 465, smtpSecure: true },
  zoho: { imapHost: "imap.zoho.com", imapPort: 993, imapSecure: true, smtpHost: "smtp.zoho.com", smtpPort: 465, smtpSecure: true },
  credence: { imapHost: "credencehousinglimited.com", imapPort: 993, imapSecure: true, smtpHost: "credencehousinglimited.com", smtpPort: 465, smtpSecure: true }
};
const detectProvider = (email: string) => {
  const d = (email.split("@")[1] || "").toLowerCase();
  if (d === "gmail.com" || d === "googlemail.com") return "gmail";
  if (/(outlook|hotmail|live)\./.test(d)) return "outlook";
  if (d.startsWith("yahoo.")) return "yahoo";
  if (d.startsWith("zoho.")) return "zoho";
  if (d === "credencehousinglimited.com") return "credence";
  return "custom";
};

// ---------------------------------------------------------------------------
// Password encryption — AES-256-GCM, key from MAIL_ENCRYPTION_KEY only.
// ---------------------------------------------------------------------------
function mailKey(): Buffer | null {
  const raw = String(process.env.MAIL_ENCRYPTION_KEY || "").trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  if (raw.length < 16) return null;
  return crypto.createHash("sha256").update(raw).digest();
}
function encryptSecret(plain: string): string {
  const key = mailKey();
  if (!key) throw bad("Credence Mail isn't set up on the server yet (MAIL_ENCRYPTION_KEY is missing). Ask the system administrator.", 503);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}
function decryptSecret(stored: string): string {
  const key = mailKey();
  if (!key) throw bad("Credence Mail isn't set up on the server (MAIL_ENCRYPTION_KEY is missing).", 503);
  const [v, iv, tag, enc] = String(stored || "").split(":");
  if (v !== "v1" || !iv || !tag || !enc) throw bad("This mailbox needs to be connected again.", 409);
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
    d.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([d.update(Buffer.from(enc, "hex")), d.final()]).toString("utf8");
  } catch {
    // The key changed since this mailbox was connected.
    throw bad("This mailbox needs to be connected again (its saved password can't be read).", 409);
  }
}

// ---------------------------------------------------------------------------
// Connection limits
// ---------------------------------------------------------------------------
const MAX_IMAP = Math.max(1, Number(process.env.MAIL_MAX_IMAP) || 20);
let imapInUse = 0;
const imapWaiters: (() => void)[] = [];
async function acquireImap() {
  if (imapInUse < MAX_IMAP) {
    imapInUse++;
    return;
  }
  await new Promise<void>((resolve) => imapWaiters.push(resolve));
  imapInUse++;
}
function releaseImap() {
  imapInUse--;
  const next = imapWaiters.shift();
  if (next) next();
}
// One operation per mailbox at a time (sync, move, delete…).
const accountLocks = new Map<number, Promise<void>>();
async function withAccountLock<T>(accountId: number, fn: () => Promise<T>): Promise<T> {
  const prev = accountLocks.get(accountId) || Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => (done = r));
  const chained = prev.then(() => mine);
  accountLocks.set(accountId, chained);
  await prev;
  try {
    return await fn();
  } finally {
    done();
    if (accountLocks.get(accountId) === chained) accountLocks.delete(accountId);
  }
}

// ---------------------------------------------------------------------------
// Categories (rule-based; the original used Ollama AI)
// ---------------------------------------------------------------------------
function categorize(fromEmail: string, subject: string, text: string): string {
  const f = fromEmail.toLowerCase();
  const all = `${subject} ${text}`.toLowerCase().slice(0, 4000);
  if (/(facebook|linkedin|twitter|x\.com|instagram|tiktok|youtube|whatsapp|pinterest|reddit)/.test(f)) return "social";
  if (/(unsubscribe|% off|sale|offer|discount|deal|promo|coupon|newsletter)/.test(all) && /(no-?reply|news|marketing|promo|offers?|info@|mailer)/.test(f)) return "promotions";
  if (/(no-?reply|notification|alerts?@|updates?@|support@|billing|receipt|invoice|statement)/.test(f) || /(receipt|invoice|your order|statement|verification code|otp|password reset)/.test(all)) return "updates";
  return "primary";
}

const ROLE_LABEL: Record<string, string> = { inbox: "Inbox", sent: "Sent", junk: "Spam", trash: "Trash", drafts: "Drafts" };
const SYNC_ROLES = ["inbox", "sent", "junk"];
const INITIAL_SYNC = Math.max(20, Number(process.env.MAIL_INITIAL_SYNC) || 200);
const BATCH_MAX = 300;

export function registerMailRoutes(app: Express, io: SocketIOServer, deps: MailDeps) {
  const { authenticateToken, queryDB, isMySQL, requireModuleLayer, hasModuleLayer } = deps;

  // -------------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------------
  const accessCache = new Map<number, { ok: boolean; at: number }>();
  async function hasMail(user: any): Promise<boolean> {
    if (!user) return false;
    if (user.onb) return false;
    if (user.role === "superadmin") return true;
    const id = Number(user.id);
    const hit = accessCache.get(id);
    if (hit && Date.now() - hit.at < 30_000) return hit.ok;
    const rows: any[] = (await queryDB("SELECT role, can_use_mail, is_onboarding FROM users WHERE id = ?", [id]).catch(() => [])) || [];
    const u = rows[0];
    const ok = !!u && (u.role === "superadmin" || (!!Number(u.can_use_mail) && !Number(u.is_onboarding)));
    accessCache.set(id, { ok, at: Date.now() });
    return ok;
  }
  // Mail Administration: an account with the "mail_open" layer can open
  // someone else's mailbox, read only, by sending X-Mail-View-As: <user id>.
  // The Superadmin's own mailbox only the Superadmin can open.
  const lastOpenLog = new Map<string, number>();
  async function viewAsTarget(req: any): Promise<number | null> {
    const raw = req.headers["x-mail-view-as"];
    if (raw === undefined || raw === "") return null;
    const target = Number(raw);
    if (!Number.isInteger(target) || target <= 0) throw bad("Unknown mailbox owner.", 400);
    if (target === Number(req.user.id)) return null;
    if (!(await hasModuleLayer(req.user, "mail_admin", "mail_open"))) throw bad("You don't have permission to open other people's mailboxes.", 403);
    const rows: any[] = (await queryDB("SELECT id, role FROM users WHERE id = ?", [target])) || [];
    if (!rows[0]) throw bad("Unknown mailbox owner.", 404);
    if (rows[0].role === "superadmin" && req.user.role !== "superadmin") throw bad("Only the Superadmin can open this mailbox.", 403);
    // Only reading: nothing in the mailbox may change (a manual sync and a
    // search on the mail server just fetch mail).
    const path = String(req.path || "");
    if (req.method !== "GET" && !(req.method === "POST" && (path === "/api/mail/sync" || path === "/api/mail/search-server"))) throw bad("An opened mailbox is read only.", 403);
    // One log line per person per mailbox every 30 minutes, not per click.
    const key = `${req.user.id}:${target}`;
    if (Date.now() - (lastOpenLog.get(key) || 0) > 30 * 60_000) {
      lastOpenLog.set(key, Date.now());
      await queryDB("INSERT INTO mail_admin_log (actor_user_id, target_user_id, action, ip, created_at) VALUES (?, ?, 'open', ?, UTC_TIMESTAMP())", [Number(req.user.id), target, String(req.ip || "").slice(0, 64)]);
    }
    return target;
  }
  const requireMail = async (req: any, res: any, next: any) => {
    try {
      if (!isMySQL()) return res.status(503).json({ error: "Credence Mail needs the MySQL database." });
      const target = await viewAsTarget(req);
      if (target) {
        req.mailViewAs = target;
        return next();
      }
      if (!(await hasMail(req.user))) return res.status(403).json({ error: "Credence Mail isn't turned on for your account." });
      next();
    } catch (err: any) {
      res.status(Number(err?.status) || 500).json({ error: err.message });
    }
  };
  const gate = [authenticateToken, requireMail];
  const fail = (res: any, err: any) => {
    const status = Number(err?.status) || 500;
    if (status >= 500 && status !== 503) console.warn("⚠️ Credence Mail:", err?.message || err);
    res.status(status).json({ error: err?.message || "Something went wrong." });
  };
  const handler = (fn: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
    try {
      await fn(req, res);
    } catch (err) {
      fail(res, err);
    }
  };
  // Whose mailbox this request works on: one's own, or the one an admin opened.
  const uid = (req: any) => Number(req.mailViewAs || req.user.id);

  async function accountOf(userId: number, accountId: any): Promise<any> {
    const rows: any[] = await queryDB("SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?", [Number(accountId), userId]);
    if (!rows[0]) throw bad("Mailbox not found.", 404);
    return rows[0];
  }
  async function accountsOf(userId: number): Promise<any[]> {
    return (await queryDB("SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY is_default DESC, id ASC", [userId])) || [];
  }
  const publicAccount = (a: any) => ({
    id: Number(a.id),
    emailAddress: a.email,
    name: a.display_name || a.email,
    provider: a.provider,
    imapHost: a.imap_host,
    imapPort: Number(a.imap_port),
    imapSecure: !!Number(a.imap_secure),
    smtpHost: a.smtp_host,
    smtpPort: Number(a.smtp_port),
    smtpSecure: !!Number(a.smtp_secure),
    isDefault: !!Number(a.is_default),
    isConnected: !a.last_error,
    // Only inside CredenceHR until its owner connects it with the password.
    internalOnly: a.provider === "internal",
    lastSyncAt: fromDb(a.last_sync_at),
    lastError: a.last_error || null
  });

  // -------------------------------------------------------------------------
  // IMAP / SMTP
  // -------------------------------------------------------------------------
  function imapClient(a: any, pass: string, insecure: boolean) {
    const c = new ImapFlow({
      host: a.imap_host,
      port: Number(a.imap_port) || 993,
      secure: !!Number(a.imap_secure),
      auth: { user: a.username, pass },
      logger: false,
      emitLogs: false,
      tls: insecure ? { rejectUnauthorized: false } : {},
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 120_000
    } as any);
    c.on("error", () => undefined);
    return c;
  }
  // Connects, falling back to an unverified certificate once (cPanel's
  // self-signed certificates) and remembering that for the mailbox.
  async function openImap(a: any): Promise<ImapFlow> {
    const pass = decryptSecret(a.password_enc);
    let c = imapClient(a, pass, !!Number(a.tls_insecure));
    try {
      await c.connect();
      return c;
    } catch (e: any) {
      if (Number(a.tls_insecure) || !isCertError(e)) throw e;
      c = imapClient(a, pass, true);
      await c.connect();
      a.tls_insecure = 1;
      if (a.id) await queryDB("UPDATE mail_accounts SET tls_insecure = 1 WHERE id = ?", [Number(a.id)]).catch(() => undefined);
      return c;
    }
  }
  // An "internal" mailbox (made for a colleague who got mail inside
  // CredenceHR before connecting their own) has no mail server behind it.
  const INTERNAL_ONLY = "This mailbox is only inside CredenceHR. Connect it with its mail password (Mailboxes → Add) to read and send outside mail too.";
  const isInternalBox = (a: any) => a?.provider === "internal";
  async function withImap<T>(a: any, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    if (isInternalBox(a)) throw bad(INTERNAL_ONLY, 409);
    await acquireImap();
    let c: ImapFlow | null = null;
    try {
      c = await openImap(a);
      return await fn(c);
    } finally {
      if (c) await c.logout().catch(() => c?.close());
      releaseImap();
    }
  }
  function smtpTransport(a: any, pass: string, insecure: boolean) {
    return nodemailer.createTransport({
      host: a.smtp_host,
      port: Number(a.smtp_port) || 465,
      secure: !!Number(a.smtp_secure),
      auth: { user: a.username, pass },
      tls: insecure ? { rejectUnauthorized: false } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000
    } as any);
  }
  async function sendRaw(a: any, envelope: { from: string; to: string[] }, raw: Buffer) {
    if (isInternalBox(a)) throw bad(`Only colleagues on Credence Mail can get mail from here (${envelope.to.join(", ")} can't). ${INTERNAL_ONLY.replace(/\.$/, "")}`, 409);
    const pass = decryptSecret(a.password_enc);
    try {
      await smtpTransport(a, pass, !!Number(a.tls_insecure)).sendMail({ envelope, raw });
    } catch (e: any) {
      if (Number(a.tls_insecure) || !isCertError(e)) throw e;
      await smtpTransport(a, pass, true).sendMail({ envelope, raw });
    }
  }
  const imapError = (e: any) =>
    e?.authenticationFailed || /auth/i.test(String(e?.responseText || ""))
      ? "The mail server refused the email or password."
      : e?.code === "ENOTFOUND"
        ? "The mail server's address wasn't found."
        : e?.code === "ECONNREFUSED" || e?.code === "ETIMEDOUT"
          ? "Couldn't reach the mail server."
          : `Mail server error: ${e?.responseText || e?.message || e}`;

  // Which folder is which on this server (Sent / Trash / Spam / Drafts).
  async function resolveFolders(a: any, c: ImapFlow): Promise<Record<string, string>> {
    const list: any[] = await c.list();
    const byUse = (use: string, names: string[]) =>
      list.find((m) => m.specialUse === use)?.path ||
      list.find((m) => names.some((n) => String(m.path).toLowerCase() === n.toLowerCase() || String(m.name).toLowerCase() === n.toLowerCase()))?.path ||
      null;
    const folders: Record<string, string> = { inbox: "INBOX" };
    const sent = byUse("\\Sent", ["Sent", "Sent Items", "Sent Messages", "INBOX.Sent", "[Gmail]/Sent Mail"]);
    const trash = byUse("\\Trash", ["Trash", "Deleted Items", "Deleted Messages", "INBOX.Trash", "[Gmail]/Trash"]);
    const junk = byUse("\\Junk", ["Junk", "Spam", "Junk E-mail", "INBOX.Junk", "INBOX.spam", "[Gmail]/Spam"]);
    const drafts = byUse("\\Drafts", ["Drafts", "INBOX.Drafts", "[Gmail]/Drafts"]);
    if (sent) folders.sent = sent;
    if (trash) folders.trash = trash;
    if (junk) folders.junk = junk;
    if (drafts) folders.drafts = drafts;
    a.folders_json = JSON.stringify(folders);
    if (a.id) await queryDB("UPDATE mail_accounts SET folders_json = ? WHERE id = ?", [a.folders_json, Number(a.id)]).catch(() => undefined);
    return folders;
  }
  async function foldersOf(a: any, c: ImapFlow) {
    const f = parseJson<Record<string, string> | null>(a.folders_json, null);
    return f && f.inbox ? f : resolveFolders(a, c);
  }

  // -------------------------------------------------------------------------
  // Settings helpers
  // -------------------------------------------------------------------------
  async function settingsOf(userId: number) {
    const r: any = ((await queryDB("SELECT * FROM mail_settings WHERE user_id = ?", [userId])) || [])[0] || {};
    return {
      signatures: parseJson<any[]>(r.signatures_json, []),
      vacationResponder: parseJson<any>(r.vacation_json, { enabled: false, subject: "", message: "" }),
      blockedSenders: parseJson<string[]>(r.blocked_json, []),
      pictureSenders: parseJson<string[]>(r.picture_senders_json, []),
      layout: parseJson<any>(r.layout_json, { density: "comfortable", previewPane: "right", theme: "light" }),
      language: r.language || "en",
      timezone: r.timezone || "Asia/Dhaka"
    };
  }

  // -------------------------------------------------------------------------
  // Turning one fetched IMAP message into a row
  // -------------------------------------------------------------------------
  const addr = (a: any) => {
    const mb = String(a?.mailbox || "").trim();
    const host = String(a?.host || "").trim();
    return mb && host ? `${mb}@${host}` : String(a?.address || "").trim();
  };
  const refList = (references: string[] | string | null | undefined): string[] =>
    (Array.isArray(references) ? references : references ? String(references).split(/\s+/) : []).map((x) => String(x).trim()).filter(Boolean);
  const threadOf = (messageId: string | null, inReplyTo: string | null, references: string[] | string | null | undefined) => {
    const refs = refList(references);
    const root = refs[0] || inReplyTo || messageId || crypto.randomUUID();
    return `t${crypto.createHash("sha1").update(root).digest("hex").slice(0, 24)}`;
  };

  // Blocked senders and the user's own rules, for mail arriving in an Inbox
  // (from the mail server, or from a colleague inside CredenceHR).
  async function incomingRules(
    userId: number,
    m: { fromEmail: string; fromName: string; to: string[]; subject: string; text: string; hasFiles: boolean },
    start: { labels: string[]; isRead: number; isStarred: number; category: string }
  ) {
    let lab = [...start.labels];
    let { isRead, isStarred, category } = start;
    const settings = await settingsOf(userId);
    const blocked = (settings.blockedSenders || []).map((b: string) => String(b).toLowerCase().trim()).filter(Boolean);
    if (blocked.some((b: string) => m.fromEmail.includes(b))) lab = ["Spam"];
    else {
      const rules: any[] = (await queryDB("SELECT * FROM mail_filters WHERE user_id = ? AND is_active = 1", [userId])) || [];
      for (const r of rules) {
        const cnd = parseJson<any>(r.conditions_json, {});
        const act = parseJson<any>(r.actions_json, {});
        const inc = (hay: string, needle: any) => !needle || hay.toLowerCase().includes(String(needle).toLowerCase());
        const ok =
          inc(m.fromEmail + " " + m.fromName, cnd.from) &&
          inc(m.to.join(" "), cnd.to) &&
          inc(m.subject, cnd.subjectContains) &&
          inc(m.text, cnd.bodyContains) &&
          (!cnd.hasAttachment || m.hasFiles);
        if (!ok) continue;
        if (act.archive) lab = lab.filter((l) => l !== "Inbox").concat("Archive");
        if (act.markRead) isRead = 1;
        if (act.star) isStarred = 1;
        if (act.categorize) category = String(act.categorize).slice(0, 30);
        const extra = [...(Array.isArray(act.applyLabels) ? act.applyLabels : []), ...(act.applyLabel ? [act.applyLabel] : [])];
        for (const l of extra) if (l && !lab.includes(String(l))) lab.push(String(l).slice(0, 60));
      }
    }
    return { labels: lab, isRead, isStarred, category };
  }

  async function storeFetched(a: any, role: string, msg: any, fresh: boolean): Promise<any | null> {
    const env = msg.envelope || {};
    let parsed: any = {};
    try {
      parsed = await simpleParser(msg.source, { skipImageLinks: true } as any);
    } catch {
      parsed = {};
    }
    const fromAddr = env.from?.[0];
    const fromEmail = (addr(fromAddr) || parsed.from?.value?.[0]?.address || "").toLowerCase().slice(0, 255);
    const fromName = String(fromAddr?.name || parsed.from?.value?.[0]?.name || fromEmail.split("@")[0] || "").trim().slice(0, 255);
    const listOf = (envList: any[], parsedList: any) =>
      (envList && envList.length ? envList.map(addr) : (parsedList?.value || []).map((x: any) => x.address)).filter(Boolean).slice(0, 200);
    const to = listOf(env.to, parsed.to);
    const cc = listOf(env.cc, parsed.cc);
    const subject = String(env.subject || parsed.subject || "(no subject)").slice(0, 2000);
    const date = env.date || parsed.date || msg.internalDate || new Date();
    const messageId = String(env.messageId || parsed.messageId || "").slice(0, 500) || null;
    const inReplyTo = String(env.inReplyTo || parsed.inReplyTo || "").slice(0, 500) || null;
    const refs = refList(parsed.references).join(" ").slice(0, 4000) || null;

    // Inline images (cid:) shown from the message itself when small.
    let html: string = parsed.html || parsed.textAsHtml || `<pre>${escapeHtml(parsed.text || "")}</pre>`;
    const files: any[] = [];
    let inlineBytes = 0;
    (parsed.attachments || []).forEach((att: any, idx: number) => {
      const cid = att.contentId ? String(att.contentId).replace(/[<>]/g, "") : "";
      if (cid && att.content && html.includes(`cid:${cid}`) && att.size < 400_000 && inlineBytes + att.size < 2_000_000) {
        inlineBytes += att.size;
        html = html.split(`cid:${cid}`).join(`data:${att.contentType || "application/octet-stream"};base64,${att.content.toString("base64")}`);
        return;
      }
      files.push({ idx, name: String(att.filename || att.generatedFileName || `attachment-${idx + 1}`).slice(0, 255), type: att.contentType || "application/octet-stream", size: att.size || 0 });
    });
    if (html.length > 15_000_000) html = html.slice(0, 15_000_000);
    const text = String(parsed.text || "").replace(/\s+/g, " ").trim();
    const snippet = (text || subject).slice(0, 200);
    const flags: Set<string> = msg.flags || new Set();
    const labels = [ROLE_LABEL[role] || "Inbox"];
    let category = role === "inbox" ? categorize(fromEmail, subject, text) : "primary";
    let isRead = flags.has("\\Seen") || role === "sent" ? 1 : 0;
    let isStarred = flags.has("\\Flagged") ? 1 : 0;
    let lab = labels;

    // Incoming mail: blocked senders go to Spam; then the user's own rules.
    if (role === "inbox") {
      const ruled = await incomingRules(Number(a.user_id), { fromEmail, fromName, to, subject, text, hasFiles: files.length > 0 }, { labels: lab, isRead, isStarred, category });
      lab = ruled.labels;
      isRead = ruled.isRead;
      isStarred = ruled.isStarred;
      category = ruled.category;
    }

    const result: any = await queryDB(
      `INSERT IGNORE INTO mail_messages
        (user_id, account_id, folder_role, uid, message_id, in_reply_to, refs, thread_id, from_name, from_email, to_json, cc_json, subject, body, snippet,
         mail_date, is_read, is_starred, labels_json, category, attachments_json, has_attachments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(a.user_id),
        Number(a.id),
        role,
        Number(msg.uid),
        messageId,
        inReplyTo,
        refs,
        threadOf(messageId, inReplyTo, parsed.references),
        fromName,
        fromEmail,
        JSON.stringify(to),
        JSON.stringify(cc),
        subject,
        html,
        snippet,
        toDb(date),
        isRead,
        isStarred,
        JSON.stringify(lab),
        category,
        JSON.stringify(files),
        files.length ? 1 : 0
      ]
    );
    if (!Number(result?.affectedRows)) return null;
    // A rule's read / star goes to the mail server too — otherwise the next
    // sync would take the server's flags back.
    const addFlags = [...(isRead && !flags.has("\\Seen") ? ["\\Seen"] : []), ...(isStarred && !flags.has("\\Flagged") ? ["\\Flagged"] : [])];
    const row = { id: Number(result.insertId), fromEmail, fromName, subject, labels: lab, date, addFlags };
    if (role === "inbox" && fresh && lab.includes("Inbox")) await maybeVacationReply(a, fromEmail, subject, date).catch(() => undefined);
    return row;
  }

  // Vacation responder: once per sender per day, only for mail that just
  // arrived (never for the old mail of a first sync).
  async function maybeVacationReply(a: any, fromEmail: string, subject: string, date: any) {
    const s = await settingsOf(Number(a.user_id));
    const v = s.vacationResponder || {};
    if (!v.enabled || !fromEmail || fromEmail === String(a.email).toLowerCase()) return;
    if (/no.?reply|mailer-daemon|postmaster|bounce/i.test(fromEmail)) return;
    const now = Date.now();
    if (v.startDate && new Date(v.startDate).getTime() > now) return;
    if (v.endDate && new Date(v.endDate).getTime() + 86_400_000 < now) return;
    if (now - new Date(date).getTime() > 2 * 86_400_000) return;
    const claim: any = await queryDB(
      "INSERT INTO mail_vacation_log (account_id, sender, sent_at) VALUES (?, ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE sent_at = IF(sent_at < UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP(), sent_at)",
      [Number(a.id), fromEmail.slice(0, 255)]
    );
    // affectedRows: 1 = new row, 2 = renewed after a day, 0 = already replied today.
    if (!Number(claim?.affectedRows)) return;
    const messageId = newMessageId(a);
    const replySubject = v.subject || `Re: ${subject}`;
    const html = `<p>${escapeHtml(String(v.message || "")).replace(/\n/g, "<br>")}</p>`;
    const raw = await new MailComposer({
      from: { name: a.display_name || a.email, address: a.email },
      to: fromEmail,
      subject: replySubject,
      html,
      messageId,
      headers: { "Auto-Submitted": "auto-replied" }
    })
      .compile()
      .build();
    // A colleague's mail is answered inside CredenceHR too; never answered
    // back (opts.auto), so two away messages can't loop.
    await sendRouted(a, [fromEmail], raw, { messageId, inReplyTo: null, refs: null, to: [fromEmail], cc: [], subject: replySubject, html, files: [] }, { auto: true });
  }

  // -------------------------------------------------------------------------
  // Sync: new mail by UID, folder by folder
  // -------------------------------------------------------------------------
  async function syncAccount(a: any, roles: string[] = SYNC_ROLES): Promise<{ inbox: number; sent: number; junk: number; fresh: any[] }> {
    if (isInternalBox(a)) return { inbox: 0, sent: 0, junk: 0, fresh: [] };
    return withAccountLock(Number(a.id), () =>
      withImap(a, async (c) => {
        const out = { inbox: 0, sent: 0, junk: 0, fresh: [] as any[] };
        const folders = await foldersOf(a, c);
        for (const role of roles) {
          const path = folders[role];
          if (!path) continue;
          let lock: any;
          try {
            lock = await c.getMailboxLock(path);
          } catch {
            continue;
          }
          try {
            const box: any = c.mailbox;
            const validity = Number(box?.uidValidity || 0);
            const st: any = ((await queryDB("SELECT * FROM mail_folder_state WHERE account_id = ? AND role = ?", [Number(a.id), role])) || [])[0];
            let lastUid = st && Number(st.uidvalidity) === validity ? Number(st.last_uid) : 0;
            const firstTime = !st;
            if (st && Number(st.uidvalidity) !== validity) {
              // The server renumbered this folder: start it again.
              await queryDB("DELETE FROM mail_messages WHERE account_id = ? AND folder_role = ? AND uid IS NOT NULL", [Number(a.id), role]);
              lastUid = 0;
            }
            const exists = Number(box?.exists || 0);
            let maxUid = lastUid;
            if (exists > 0) {
              let range: string;
              let byUid = true;
              if (lastUid === 0) {
                range = `${Math.max(1, exists - INITIAL_SYNC + 1)}:*`;
                byUid = false;
              } else range = `${lastUid + 1}:*`;
              const msgs: any[] = [];
              for await (const m of c.fetch(range, { uid: true, envelope: true, flags: true, source: true, internalDate: true }, { uid: byUid })) {
                if (Number(m.uid) <= lastUid) continue;
                msgs.push(m);
                if (msgs.length >= BATCH_MAX) break;
              }
              msgs.sort((x, y) => Number(x.uid) - Number(y.uid));
              for (const m of msgs) {
                maxUid = Math.max(maxUid, Number(m.uid));
                // Our own sent mail, already saved when it was sent.
                if (role === "sent" && m.envelope?.messageId) {
                  const dup: any[] = await queryDB("SELECT id FROM mail_messages WHERE account_id = ? AND message_id = ? AND folder_role = 'sent' LIMIT 1", [Number(a.id), String(m.envelope.messageId).slice(0, 500)]);
                  if (dup.length) {
                    await queryDB("UPDATE mail_messages SET uid = ? WHERE id = ? AND uid IS NULL", [Number(m.uid), Number(dup[0].id)]).catch(() => undefined);
                    continue;
                  }
                }
                const row = await storeFetched(a, role, m, !firstTime);
                if (row?.addFlags.length) await c.messageFlagsAdd(String(m.uid), row.addFlags, { uid: true }).catch(() => undefined);
                if (row) {
                  (out as any)[role]++;
                  if (role === "inbox" && !firstTime && row.labels.includes("Inbox")) out.fresh.push(row);
                }
              }
            }
            await queryDB(
              "INSERT INTO mail_folder_state (account_id, role, path, uidvalidity, last_uid) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE path = VALUES(path), uidvalidity = VALUES(uidvalidity), last_uid = VALUES(last_uid)",
              [Number(a.id), role, path, validity, maxUid]
            );
            // Read / starred changed elsewhere (phone, webmail) — recent inbox only.
            if (role === "inbox" && lastUid > 0 && exists > 0) {
              const since = Math.max(1, exists - 300 + 1);
              const flagsByUid = new Map<number, Set<string>>();
              for await (const m of c.fetch(`${since}:*`, { uid: true, flags: true })) flagsByUid.set(Number(m.uid), m.flags || new Set());
              if (flagsByUid.size) {
                const uids = [...flagsByUid.keys()];
                const rows: any[] = await queryDB(
                  `SELECT id, uid, is_read, is_starred FROM mail_messages WHERE account_id = ? AND folder_role = 'inbox' AND uid IN (${uids.map(() => "?").join(",")})`,
                  [Number(a.id), ...uids]
                );
                for (const r of rows) {
                  const f = flagsByUid.get(Number(r.uid));
                  if (!f) continue;
                  const read = f.has("\\Seen") ? 1 : 0;
                  const star = f.has("\\Flagged") ? 1 : 0;
                  if (read !== Number(r.is_read) || star !== Number(r.is_starred)) {
                    await queryDB("UPDATE mail_messages SET is_read = ?, is_starred = ? WHERE id = ?", [read, star, Number(r.id)]);
                  }
                }
              }
            }
          } finally {
            lock.release();
          }
        }
        await queryDB("UPDATE mail_accounts SET last_sync_at = UTC_TIMESTAMP(), last_error = NULL WHERE id = ?", [Number(a.id)]);
        a.last_error = null;
        return out;
      })
    );
  }
  // New mail in someone's Inbox: the open screen hears "mail:new", and
  // CredenceHR's own notifications (the Alerts bell, and a push to the
  // phone) — Credence Mail has no bell of its own.
  function announceNew(userId: number, accountId: number, fresh: { id: number; fromName: string; fromEmail: string; subject: string }[]) {
    if (!fresh.length) return;
    const latest = fresh[fresh.length - 1];
    io.to(`user:${userId}`).emit("mail:new", { accountId, count: fresh.length, from: latest.fromName || latest.fromEmail, subject: latest.subject });
    const n = fresh.length;
    void createAlert(queryDB, {
      userId,
      type: "mail",
      title: n > 1 ? `${n} new mails` : `New mail from ${latest.fromName || latest.fromEmail}`,
      message: n > 1 ? `Latest: ${latest.subject} — ${latest.fromName || latest.fromEmail}` : String(latest.subject || "(no subject)"),
      relatedType: "mail_message",
      relatedId: Number(latest.id)
    });
  }
  async function syncAndNotify(a: any, roles?: string[]) {
    try {
      const r = await syncAccount(a, roles);
      if (r.fresh.length) announceNew(Number(a.user_id), Number(a.id), r.fresh);
      if (r.inbox || r.sent || r.junk) io.to(`user:${Number(a.user_id)}`).emit("mail:changed", { accountId: Number(a.id) });
      return r;
    } catch (e: any) {
      const msg = e?.status ? e.message : imapError(e);
      await queryDB("UPDATE mail_accounts SET last_error = ? WHERE id = ?", [String(msg).slice(0, 500), Number(a.id)]).catch(() => undefined);
      throw Object.assign(new Error(msg), { status: e?.status || 502 });
    }
  }

  // -------------------------------------------------------------------------
  // Internal delivery
  // -------------------------------------------------------------------------
  // Mail from one of our own mailboxes (credencehousinglimited.com, or the
  // domains set in Mail Administration) to a colleague whose mailbox is
  // connected in CredenceHR never goes through the mail server (cPanel): it
  // is put straight into the colleague's Inbox here. Only the recipients
  // outside — another domain, or one of ours that isn't connected in
  // CredenceHR / whose Credence Mail is off — get it through SMTP. To and Cc
  // stay as written for everyone, so a Reply-all from outside still reaches
  // all; Bcc is never shown to anyone.
  // Such mail is only in CredenceHR — Outlook or a phone's mail app on the
  // cPanel mailbox doesn't see it.
  const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  const DEFAULT_DOMAINS = ["credencehousinglimited.com"];
  let systemCache: { at: number; v: { internalDelivery: boolean; domains: string[] } } | null = null;
  async function systemSettings() {
    if (systemCache && Date.now() - systemCache.at < 30_000) return systemCache.v;
    const row: any = ((await queryDB("SELECT * FROM mail_system_settings WHERE id = 1").catch(() => [])) || [])[0];
    const domains = row
      ? String(row.internal_domains || "")
          .split(/[\s,;]+/)
          .map((d) => d.trim().toLowerCase())
          .filter((d) => DOMAIN_RE.test(d))
      : DEFAULT_DOMAINS;
    const v = { internalDelivery: row ? !!Number(row.internal_delivery) : true, domains };
    systemCache = { at: Date.now(), v };
    return v;
  }
  const domainOf = (email: string) => (String(email).split("@")[1] || "").toLowerCase();

  // Which recipients get the mail inside CredenceHR: address -> the
  // connected mailboxes with that address (usually one).
  async function internalTargets(a: any, recipients: string[], opts: { create?: boolean } = { create: true }): Promise<Map<string, any[]>> {
    const out = new Map<string, any[]>();
    const sys = await systemSettings();
    if (!sys.internalDelivery || !sys.domains.includes(domainOf(a.email))) return out;
    const wanted = [...new Set(recipients.map((x) => x.toLowerCase()))].filter((x) => sys.domains.includes(domainOf(x)));
    if (!wanted.length) return out;
    // Unscoped: an address is the same mailbox whichever company is active.
    const rows: any[] =
      (await queryDB(
        `/*unscoped*/ SELECT m.id, m.user_id, m.email, u.role, u.can_use_mail, u.is_onboarding, u.is_blocked
         FROM mail_accounts m JOIN users u ON u.id = m.user_id
         WHERE m.email IN (${wanted.map(() => "?").join(",")})`,
        wanted
      )) || [];
    const on = (r: any) => !Number(r.is_blocked) && (r.role === "superadmin" || (!!Number(r.can_use_mail) && !Number(r.is_onboarding)));
    for (const r of rows) {
      if (!on(r)) continue;
      const k = String(r.email).toLowerCase();
      out.set(k, [...(out.get(k) || []), r]);
    }
    // A colleague who hasn't connected that mailbox in Credence Mail yet, but
    // whose CredenceHR account has that address (login email, or the
    // Employee's official email) and Credence Mail on: the mail waits for
    // them in an inside-only mailbox, made now. When they connect the real
    // mailbox later it becomes that one, mail and all.
    const missing = wanted.filter((x) => !out.has(x) && !rows.some((r) => String(r.email).toLowerCase() === x));
    if (missing.length && opts.create) {
      const marks = missing.map(() => "?").join(",");
      const people: any[] = [
        ...((await queryDB(`/*unscoped*/ SELECT id AS user_id, name, LOWER(email) AS email, role, can_use_mail, is_onboarding, is_blocked FROM users WHERE LOWER(email) IN (${marks})`, missing).catch(() => [])) || []),
        ...((await queryDB(
          `/*unscoped*/ SELECT u.id AS user_id, COALESCE(e.name, u.name) AS name, LOWER(e.email) AS email, u.role, u.can_use_mail, u.is_onboarding, u.is_blocked
           FROM all_employees e JOIN users u ON u.id = e.user_id WHERE e.user_id IS NOT NULL AND LOWER(e.email) IN (${marks})`,
          missing
        ).catch(() => [])) || [])
      ];
      for (const email of missing) {
        const owners = [...new Map(people.filter((p) => p.email === email && on(p)).map((p) => [Number(p.user_id), p])).values()];
        for (const p of owners) {
          const box = await ensureInternalBox(Number(p.user_id), email, p.name);
          if (box) out.set(email, [...(out.get(email) || []), box]);
        }
      }
    } else if (missing.length) {
      // A look only (the Compose preview): who would get it inside.
      const marks = missing.map(() => "?").join(",");
      const people: any[] = [
        ...((await queryDB(`/*unscoped*/ SELECT id AS user_id, LOWER(email) AS email, role, can_use_mail, is_onboarding, is_blocked FROM users WHERE LOWER(email) IN (${marks})`, missing).catch(() => [])) || []),
        ...((await queryDB(
          `/*unscoped*/ SELECT u.id AS user_id, LOWER(e.email) AS email, u.role, u.can_use_mail, u.is_onboarding, u.is_blocked
           FROM all_employees e JOIN users u ON u.id = e.user_id WHERE e.user_id IS NOT NULL AND LOWER(e.email) IN (${marks})`,
          missing
        ).catch(() => [])) || [])
      ];
      for (const p of people) if (on(p)) out.set(p.email, [...(out.get(p.email) || []), { id: 0, user_id: p.user_id, email: p.email }]);
    }
    return out;
  }
  async function ensureInternalBox(userId: number, email: string, name: string | null): Promise<any | null> {
    const has: any[] = (await queryDB("SELECT COUNT(*) AS n FROM mail_accounts WHERE user_id = ?", [userId])) || [];
    const r: any = await queryDB(
      `INSERT INTO mail_accounts (user_id, email, display_name, provider, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc, tls_insecure, is_default)
       VALUES (?, ?, ?, 'internal', '', 0, 0, '', 0, 0, ?, '', 0, ?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [userId, email, name || email.split("@")[0], email, Number(has[0]?.n || 0) ? 0 : 1]
    );
    const id = Number(r?.insertId);
    if (!id) return null;
    return { id, user_id: userId, email };
  }

  // Attachments of internal mail are kept once (mail_blobs), whichever and
  // however many mailboxes hold them.
  async function blobIds(files: { name: string; mime: string; data: Buffer }[]): Promise<number[]> {
    const ids: number[] = [];
    for (const f of files) {
      const sha = crypto.createHash("sha256").update(f.data).digest("hex");
      const r: any = await queryDB(
        "INSERT INTO mail_blobs (sha256, size, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), created_at = CURRENT_TIMESTAMP",
        [sha, f.data.length, f.data]
      );
      ids.push(Number(r.insertId));
    }
    return ids;
  }

  type Outgoing = {
    messageId: string;
    inReplyTo: string | null;
    refs: string | null;
    to: string[];
    cc: string[];
    subject: string;
    html: string;
    files: { name: string; mime: string; data: Buffer }[];
    blobs?: number[];
  };
  // Puts the mail into each internal recipient's Inbox, with their own
  // blocked senders and rules applied, and tells them.
  async function deliverInside(a: any, targets: Map<string, any[]>, m: Outgoing, opts: { auto?: boolean } = {}): Promise<number[]> {
    const accounts = new Map<number, any>();
    for (const list of targets.values()) for (const t of list) accounts.set(Number(t.id), t);
    if (!accounts.size) return [];
    const blobs = m.blobs || (m.files.length ? await blobIds(m.files) : []);
    const meta = m.files.map((f, idx) => ({ idx, name: f.name, type: f.mime, size: f.data.length }));
    const text = m.html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    const fromEmail = String(a.email).toLowerCase();
    const fromName = a.display_name || a.email;
    const subject = m.subject || "(no subject)";
    const thread = threadOf(m.messageId, m.inReplyTo, m.refs);
    for (const t of accounts.values()) {
      // Already there (a retried send): once is enough.
      const dup: any[] = await queryDB("SELECT id FROM mail_messages WHERE account_id = ? AND message_id = ? AND folder_role = 'inbox' LIMIT 1", [Number(t.id), m.messageId]);
      if (dup.length) continue;
      const ruled = await incomingRules(
        Number(t.user_id),
        { fromEmail, fromName, to: m.to, subject, text, hasFiles: m.files.length > 0 },
        { labels: ["Inbox"], isRead: 0, isStarred: 0, category: categorize(fromEmail, subject, text) }
      );
      const ins: any = await queryDB(
        `INSERT INTO mail_messages
          (user_id, account_id, folder_role, uid, message_id, in_reply_to, refs, thread_id, from_name, from_email, to_json, cc_json, bcc_json, subject, body, snippet,
           mail_date, is_read, is_starred, labels_json, category, attachments_json, has_attachments, via_internal)
         VALUES (?, ?, 'inbox', NULL, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, 1)`,
        [
          Number(t.user_id),
          Number(t.id),
          m.messageId,
          m.inReplyTo,
          m.refs,
          thread,
          fromName,
          fromEmail,
          JSON.stringify(m.to),
          JSON.stringify(m.cc),
          subject,
          m.html,
          (text || subject).slice(0, 200),
          ruled.isRead,
          ruled.isStarred,
          JSON.stringify(ruled.labels),
          ruled.category,
          JSON.stringify(meta),
          meta.length ? 1 : 0
        ]
      );
      const id = Number(ins.insertId);
      for (let i = 0; i < m.files.length; i++) {
        await queryDB("INSERT INTO mail_files (message_id, idx, name, mime, size, data, blob_id) VALUES (?, ?, ?, ?, ?, NULL, ?)", [id, i, m.files[i].name, m.files[i].mime, m.files[i].data.length, blobs[i]]);
      }
      io.to(`user:${Number(t.user_id)}`).emit("mail:changed", { accountId: Number(t.id) });
      if (ruled.labels.includes("Inbox")) {
        announceNew(Number(t.user_id), Number(t.id), [{ id, fromName, fromEmail, subject }]);
        if (!opts.auto) {
          const full: any = ((await queryDB("SELECT * FROM mail_accounts WHERE id = ?", [Number(t.id)])) || [])[0];
          if (full) void maybeVacationReply(full, fromEmail, subject, new Date()).catch(() => undefined);
        }
      }
    }
    return blobs;
  }

  // Sends one built message: inside CredenceHR to the internal recipients,
  // by SMTP to the rest. SMTP goes first — if it fails, nobody got it yet
  // and the mail can simply be sent again.
  async function sendRouted(a: any, recipients: string[], raw: Buffer, m: Outgoing, opts: { auto?: boolean } = {}) {
    const all = [...new Set(recipients.map((x) => x.toLowerCase()))];
    const internal = await internalTargets(a, all);
    const external = all.filter((x) => !internal.has(x));
    if (external.length) await sendRaw(a, { from: a.email, to: external }, raw);
    const blobs = internal.size ? await deliverInside(a, internal, m, opts) : [];
    return { internal: [...internal.keys()], external, blobs };
  }

  // -------------------------------------------------------------------------
  // Pushing a change to the mail server
  // -------------------------------------------------------------------------
  async function serverFlags(a: any, row: any, set: { read?: boolean; star?: boolean }) {
    if (!row.uid || !row.folder_role) return;
    await withAccountLock(Number(a.id), () =>
      withImap(a, async (c) => {
        const folders = await foldersOf(a, c);
        const path = folders[row.folder_role];
        if (!path) return;
        const lock = await c.getMailboxLock(path);
        try {
          const range = String(row.uid);
          if (set.read !== undefined) await (set.read ? c.messageFlagsAdd(range, ["\\Seen"], { uid: true }) : c.messageFlagsRemove(range, ["\\Seen"], { uid: true }));
          if (set.star !== undefined) await (set.star ? c.messageFlagsAdd(range, ["\\Flagged"], { uid: true }) : c.messageFlagsRemove(range, ["\\Flagged"], { uid: true }));
        } finally {
          lock.release();
        }
      })
    );
  }
  // Moves to another folder role; returns the new UID (or null).
  async function serverMove(a: any, row: any, toRole: string): Promise<number | null | undefined> {
    if (!row.uid || !row.folder_role || row.folder_role === toRole) return undefined;
    return withAccountLock(Number(a.id), () =>
      withImap(a, async (c) => {
        const folders = await foldersOf(a, c);
        const from = folders[row.folder_role];
        const to = folders[toRole];
        if (!from || !to) return undefined;
        const lock = await c.getMailboxLock(from);
        try {
          const r: any = await c.messageMove(String(row.uid), to, { uid: true });
          const map: Map<number, number> | undefined = r?.uidMap;
          return map?.get(Number(row.uid)) ?? null;
        } finally {
          lock.release();
        }
      })
    );
  }
  async function serverDelete(a: any, row: any) {
    if (!row.uid || !row.folder_role) return;
    await withAccountLock(Number(a.id), () =>
      withImap(a, async (c) => {
        const folders = await foldersOf(a, c);
        const path = folders[row.folder_role];
        if (!path) return;
        const lock = await c.getMailboxLock(path);
        try {
          await c.messageDelete(String(row.uid), { uid: true });
        } finally {
          lock.release();
        }
      })
    );
  }
  // Moving between Inbox / Trash / Spam: which folder a set of labels means.
  const roleForLabels = (labels: string[], current: string | null) => {
    if (labels.includes("Trash")) return "trash";
    if (labels.includes("Spam")) return "junk";
    if (labels.includes("Inbox") && (current === "trash" || current === "junk")) return "inbox";
    return current;
  };

  // -------------------------------------------------------------------------
  // Message rows -> API shape (the credence-mail screens' Email type)
  // -------------------------------------------------------------------------
  const toApi = (r: any, withBody: boolean) => ({
    id: String(r.id),
    accountId: Number(r.account_id),
    threadId: r.thread_id,
    from: { name: r.from_name || (r.from_email || "").split("@")[0] || "Unknown", email: r.from_email || "" },
    to: parseJson<string[]>(r.to_json, []),
    cc: parseJson<string[]>(r.cc_json, []),
    bcc: parseJson<string[]>(r.bcc_json, []),
    subject: r.subject || "(no subject)",
    ...(withBody ? { body: r.body || "" } : {}),
    snippet: r.snippet || "",
    date: fromDb(r.mail_date),
    isRead: !!Number(r.is_read),
    isStarred: !!Number(r.is_starred),
    isImportant: !!Number(r.is_important),
    isDraft: parseJson<string[]>(r.labels_json, []).includes("Drafts"),
    labels: parseJson<string[]>(r.labels_json, []),
    category: r.category || "primary",
    attachments: parseJson<any[]>(r.attachments_json, []),
    hasAttachments: !!Number(r.has_attachments),
    scheduledSendTime: fromDb(r.scheduled_at),
    sendError: r.send_error || null,
    messageId: r.message_id || null,
    // Came / went inside CredenceHR, not through the mail server.
    internal: !!Number(r.via_internal)
  });
  const LIST_COLS =
    "id, account_id, thread_id, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, mail_date, is_read, is_starred, is_important, labels_json, category, attachments_json, has_attachments, scheduled_at, send_error, message_id, via_internal";
  async function messageOf(userId: number, id: any, withBody = true): Promise<any> {
    const rows: any[] = await queryDB(`SELECT ${withBody ? "*" : LIST_COLS + ", folder_role, uid"} FROM mail_messages WHERE id = ? AND user_id = ?`, [Number(id), userId]);
    if (!rows[0]) throw bad("Message not found.", 404);
    return rows[0];
  }

  // =========================================================================
  // Routes
  // =========================================================================

  // Whether Credence Mail is on for this account and ready on the server.
  app.get(
    "/api/mail/status",
    authenticateToken,
    handler(async (req, res) => {
      const enabled = isMySQL() && (await hasMail(req.user));
      res.json({
        enabled,
        serverReady: !!mailKey(),
        ourDomains: enabled ? (await systemSettings()).domains : [],
        accounts: enabled ? (await accountsOf(uid(req))).map(publicAccount) : []
      });
    })
  );

  // ---- Admin Panel -> Mail Administration ------------------------------------
  // Everyone's connected mailboxes in this company (queryDB scopes "users" to
  // the active company). Opening one uses X-Mail-View-As (requireMail above).
  async function adminMailboxes(): Promise<any[]> {
    return (
      (await queryDB(
        `SELECT a.id, a.user_id, a.email, a.display_name, a.provider, a.imap_host, a.smtp_host, a.last_sync_at, a.last_error, a.created_at,
                u.name AS user_name, u.email AS user_login, u.username AS user_username, u.role AS user_role
         FROM mail_accounts a JOIN users u ON u.id = a.user_id
         ORDER BY u.name ASC, a.email ASC`
      )) || []
    );
  }
  const noStore = (res: any) => res.setHeader("Cache-Control", "no-store");
  app.get(
    "/api/mail/admin/accounts",
    authenticateToken,
    requireModuleLayer("mail_admin", "read"),
    handler(async (req, res) => {
      if (!isMySQL()) throw bad("Credence Mail needs the MySQL database.", 503);
      const [canOpen, canPassword] = await Promise.all([hasModuleLayer(req.user, "mail_admin", "mail_open"), hasModuleLayer(req.user, "mail_admin", "mail_password")]);
      const isSuper = req.user.role === "superadmin";
      noStore(res);
      res.json({
        canOpen,
        canPassword,
        serverReady: !!mailKey(),
        items: (await adminMailboxes()).map((r) => ({
          id: Number(r.id),
          userId: Number(r.user_id),
          userName: r.user_name || r.user_login || r.user_username || `#${r.user_id}`,
          userLogin: r.user_login || r.user_username || "",
          emailAddress: r.email,
          name: r.display_name || r.email,
          provider: r.provider,
          imapHost: r.imap_host,
          smtpHost: r.smtp_host,
          lastSyncAt: fromDb(r.last_sync_at),
          lastError: r.last_error || null,
          connectedAt: fromDb(r.created_at),
          // The Superadmin's own mailbox is only for the Superadmin.
          locked: r.user_role === "superadmin" && !isSuper
        }))
      });
    })
  );
  app.post(
    "/api/mail/admin/accounts/:id/password",
    authenticateToken,
    requireModuleLayer("mail_admin", "mail_password"),
    handler(async (req, res) => {
      if (!isMySQL()) throw bad("Credence Mail needs the MySQL database.", 503);
      const id = Number(req.params.id);
      const row = (await adminMailboxes()).find((r) => Number(r.id) === id);
      if (!row) throw bad("Mailbox not found.", 404);
      if (row.user_role === "superadmin" && req.user.role !== "superadmin") throw bad("Only the Superadmin can see this mailbox's password.", 403);
      const full: any = ((await queryDB("SELECT password_enc, provider FROM mail_accounts WHERE id = ?", [id])) || [])[0];
      if (!full) throw bad("Mailbox not found.", 404);
      if (isInternalBox(full)) throw bad("This mailbox is only inside CredenceHR — it has no saved password.", 409);
      const password = decryptSecret(full.password_enc);
      await queryDB("INSERT INTO mail_admin_log (actor_user_id, target_user_id, account_id, action, ip, created_at) VALUES (?, ?, ?, 'password', ?, UTC_TIMESTAMP())", [
        Number(req.user.id),
        Number(row.user_id),
        id,
        String(req.ip || "").slice(0, 64)
      ]);
      noStore(res);
      res.json({ password });
    })
  );
  app.get(
    "/api/mail/admin/log",
    authenticateToken,
    requireModuleLayer("mail_admin", "read"),
    handler(async (req, res) => {
      if (!isMySQL()) throw bad("Credence Mail needs the MySQL database.", 503);
      const rows: any[] =
        (await queryDB(
          `SELECT l.id, l.action, l.account_id, l.created_at, l.actor_user_id, l.target_user_id, a.name AS actor_name, t.name AS target_name, m.email AS mailbox
           FROM mail_admin_log l
           JOIN users t ON t.id = l.target_user_id
           LEFT JOIN users a ON a.id = l.actor_user_id
           LEFT JOIN mail_accounts m ON m.id = l.account_id
           ORDER BY l.id DESC LIMIT 300`
        )) || [];
      noStore(res);
      res.json(
        rows.map((r) => ({
          id: Number(r.id),
          action: r.action,
          at: fromDb(r.created_at),
          actor: r.actor_name || `#${r.actor_user_id}`,
          target: r.target_name || `#${r.target_user_id}`,
          mailbox: r.mailbox || null
        }))
      );
    })
  );

  // Compose: which of these recipients would get the mail inside CredenceHR
  // and which through the mail server (nothing is created or sent).
  app.post(
    "/api/mail/route-preview",
    ...gate,
    handler(async (req, res) => {
      const a = await accountOf(uid(req), req.body?.accountId);
      const all = [...new Set([...splitAddresses(req.body?.to), ...splitAddresses(req.body?.cc), ...splitAddresses(req.body?.bcc)].map((x) => x.toLowerCase()))];
      const inside = await internalTargets(a, all, { create: false });
      res.json({
        internal: all.filter((x) => inside.has(x)),
        external: all.filter((x) => !inside.has(x)),
        // So the screen can say why ours went out through the server.
        ourDomains: (await systemSettings()).domains,
        enabled: (await systemSettings()).internalDelivery
      });
    })
  );

  // Internal delivery on / off and which domains are ours. Seeing it: the
  // module's "read"; changing it: the explicit-only "mail_settings" layer.
  const publicSystem = async (req: any) => ({
    ...(await systemSettings()),
    canEdit: await hasModuleLayer(req.user, "mail_admin", "mail_settings")
  });
  app.get(
    "/api/mail/admin/settings",
    authenticateToken,
    requireModuleLayer("mail_admin", "read"),
    handler(async (req, res) => {
      if (!isMySQL()) throw bad("Credence Mail needs the MySQL database.", 503);
      res.json(await publicSystem(req));
    })
  );
  app.put(
    "/api/mail/admin/settings",
    authenticateToken,
    requireModuleLayer("mail_admin", "mail_settings"),
    handler(async (req, res) => {
      if (!isMySQL()) throw bad("Credence Mail needs the MySQL database.", 503);
      const b = req.body || {};
      const cur = await systemSettings();
      const on = b.internalDelivery === undefined ? cur.internalDelivery : !!b.internalDelivery;
      let domains = cur.domains;
      if (b.domains !== undefined) {
        const list = (Array.isArray(b.domains) ? b.domains : String(b.domains).split(/[\s,;]+/)).map((d: any) => String(d || "").trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
        const wrong = list.filter((d: string) => !DOMAIN_RE.test(d));
        if (wrong.length) throw bad(`Not a domain: ${wrong.join(", ")}`);
        domains = [...new Set<string>(list)].slice(0, 10);
        if (!domains.length) throw bad("Keep at least one domain (e.g. credencehousinglimited.com).");
      }
      await queryDB(
        `INSERT INTO mail_system_settings (id, internal_delivery, internal_domains, updated_by) VALUES (1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE internal_delivery = VALUES(internal_delivery), internal_domains = VALUES(internal_domains), updated_by = VALUES(updated_by)`,
        [on ? 1 : 0, domains.join(","), Number(req.user.id)]
      );
      systemCache = null;
      res.json(await publicSystem(req));
    })
  );

  // ---- Mailboxes ----------------------------------------------------------
  app.get(
    "/api/mail/accounts",
    ...gate,
    handler(async (req, res) => res.json((await accountsOf(uid(req))).map(publicAccount)))
  );

  // Connect a mailbox: checked against the mail server, then saved.
  app.post(
    "/api/mail/accounts",
    ...gate,
    handler(async (req, res) => {
      const b = req.body || {};
      const email = str(b.email || b.emailAddress).toLowerCase();
      const password = typeof b.password === "string" ? b.password : "";
      if (!isEmail(email)) throw bad("Enter a valid email address.");
      if (!password) throw bad("Enter the mailbox password.");
      if (!mailKey()) throw bad("Credence Mail isn't set up on the server yet (MAIL_ENCRYPTION_KEY is missing). Ask the system administrator.", 503);
      const mine = await accountsOf(uid(req));
      if (mine.length >= 5 && !mine.some((x) => x.email === email)) throw bad("At most 5 mailboxes per account.");
      const provider = detectProvider(email);
      const p = PRESETS[provider];
      const domain = email.split("@")[1];
      const a: any = {
        user_id: uid(req),
        email,
        display_name: str(b.name) || req.user.name || email.split("@")[0],
        provider,
        imap_host: str(b.imapHost) || p?.imapHost || domain,
        imap_port: Number(b.imapPort) || p?.imapPort || 993,
        imap_secure: b.imapSecure !== undefined ? (b.imapSecure ? 1 : 0) : p ? (p.imapSecure ? 1 : 0) : 1,
        smtp_host: str(b.smtpHost) || p?.smtpHost || domain,
        smtp_port: Number(b.smtpPort) || p?.smtpPort || 465,
        smtp_secure: b.smtpSecure !== undefined ? (b.smtpSecure ? 1 : 0) : p ? (p.smtpSecure ? 1 : 0) : 1,
        username: str(b.username) || email,
        tls_insecure: 0
      };
      a.password_enc = encryptSecret(password);
      // IMAP must work; SMTP is checked too so sending won't fail later.
      try {
        await withImap(a, async (c) => resolveFolders(a, c));
      } catch (e: any) {
        throw bad(imapError(e), 400);
      }
      try {
        const t = smtpTransport(a, password, !!a.tls_insecure);
        try {
          await t.verify();
        } catch (e: any) {
          if (a.tls_insecure || !isCertError(e)) throw e;
          await smtpTransport(a, password, true).verify();
          a.tls_insecure = 1;
        }
      } catch (e: any) {
        throw bad(`Reading mail works, but sending doesn't: ${e?.response || e?.message || e}. Check the SMTP settings.`, 400);
      }
      await queryDB(
        `INSERT INTO mail_accounts (user_id, email, display_name, provider, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc, tls_insecure, folders_json, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), provider = VALUES(provider), imap_host = VALUES(imap_host), imap_port = VALUES(imap_port),
           imap_secure = VALUES(imap_secure), smtp_host = VALUES(smtp_host), smtp_port = VALUES(smtp_port), smtp_secure = VALUES(smtp_secure),
           username = VALUES(username), password_enc = VALUES(password_enc), tls_insecure = VALUES(tls_insecure), folders_json = VALUES(folders_json), last_error = NULL`,
        [a.user_id, a.email, a.display_name, a.provider, a.imap_host, a.imap_port, a.imap_secure, a.smtp_host, a.smtp_port, a.smtp_secure, a.username, a.password_enc, a.tls_insecure, a.folders_json, mine.length ? 0 : 1]
      );
      const saved: any = ((await queryDB("SELECT * FROM mail_accounts WHERE user_id = ? AND email = ?", [a.user_id, a.email])) || [])[0];
      res.status(201).json(publicAccount(saved));
      // First sync in the background; the screen hears "mail:changed".
      syncAndNotify(saved).catch(() => undefined);
    })
  );

  app.put(
    "/api/mail/accounts/:id",
    ...gate,
    handler(async (req, res) => {
      const a = await accountOf(uid(req), req.params.id);
      const name = str(req.body?.name);
      if (name) await queryDB("UPDATE mail_accounts SET display_name = ? WHERE id = ?", [name, Number(a.id)]);
      if (req.body?.isDefault) {
        await queryDB("UPDATE mail_accounts SET is_default = 0 WHERE user_id = ?", [uid(req)]);
        await queryDB("UPDATE mail_accounts SET is_default = 1 WHERE id = ?", [Number(a.id)]);
      }
      res.json(publicAccount(await accountOf(uid(req), a.id)));
    })
  );

  app.delete(
    "/api/mail/accounts/:id",
    ...gate,
    handler(async (req, res) => {
      const a = await accountOf(uid(req), req.params.id);
      stopIdle(Number(a.id));
      await queryDB("DELETE f FROM mail_files f JOIN mail_messages m ON m.id = f.message_id WHERE m.account_id = ?", [Number(a.id)]);
      await queryDB("DELETE FROM mail_messages WHERE account_id = ?", [Number(a.id)]);
      await queryDB("DELETE FROM mail_folder_state WHERE account_id = ?", [Number(a.id)]);
      await queryDB("DELETE FROM mail_vacation_log WHERE account_id = ?", [Number(a.id)]);
      await queryDB("DELETE FROM mail_accounts WHERE id = ?", [Number(a.id)]);
      if (Number(a.is_default)) {
        const rest = await accountsOf(uid(req));
        if (rest[0]) await queryDB("UPDATE mail_accounts SET is_default = 1 WHERE id = ?", [Number(rest[0].id)]);
      }
      res.json({ success: true });
    })
  );

  // ---- Sync ---------------------------------------------------------------
  const lastManualSync = new Map<number, number>();
  app.post(
    "/api/mail/sync",
    ...gate,
    handler(async (req, res) => {
      const list = req.body?.accountId ? [await accountOf(uid(req), req.body.accountId)] : await accountsOf(uid(req));
      const result: any[] = [];
      for (const a of list) {
        // A sync for the same mailbox a few seconds ago is enough.
        const prev = lastManualSync.get(Number(a.id)) || 0;
        if (Date.now() - prev < 10_000) {
          result.push({ accountId: Number(a.id), skipped: true });
          continue;
        }
        lastManualSync.set(Number(a.id), Date.now());
        try {
          const r = await syncAndNotify(a);
          result.push({ accountId: Number(a.id), inbox: r.inbox, sent: r.sent, spam: r.junk });
        } catch (e: any) {
          result.push({ accountId: Number(a.id), error: e.message });
        }
      }
      res.json({ accounts: result });
    })
  );

  // ---- Messages -----------------------------------------------------------
  // ?accountId= &label=Inbox|Sent|Drafts|Scheduled|Starred|Important|Spam|Trash|Archive|<own>
  // &category= &q= &page= &limit=  (one page at a time, no bodies)
  app.get(
    "/api/mail/messages",
    ...gate,
    handler(async (req, res) => {
      const where: string[] = ["user_id = ?"];
      const params: any[] = [uid(req)];
      if (req.query.accountId) {
        await accountOf(uid(req), req.query.accountId);
        where.push("account_id = ?");
        params.push(Number(req.query.accountId));
      }
      const label = str(req.query.label, 60) || "Inbox";
      const has = (l: string) => `labels_json LIKE ${queryLike(l)}`;
      const queryLike = (l: string) => {
        params.push(`%${JSON.stringify(l)}%`);
        return "?";
      };
      if (label === "Starred") where.push("is_starred = 1", `NOT ${has("Trash")}`, `NOT ${has("Spam")}`);
      else if (label === "Important") where.push("is_important = 1", `NOT ${has("Trash")}`, `NOT ${has("Spam")}`);
      else if (label === "All") where.push(`NOT ${has("Trash")}`, `NOT ${has("Spam")}`, `NOT ${has("Drafts")}`, `NOT ${has("Scheduled")}`);
      else if (label === "Unread") where.push("is_read = 0", has("Inbox"));
      else {
        where.push(has(label));
        if (label !== "Trash") where.push(`NOT ${has("Trash")}`);
        if (label !== "Spam" && label !== "Trash") where.push(`NOT ${has("Spam")}`);
      }
      if (req.query.category) {
        where.push("category = ?");
        params.push(str(req.query.category, 30));
      }
      const q = str(req.query.q, 200);
      if (q) {
        // Each word on its own, anywhere in the mail (subject, people, text).
        for (const word of q.split(/\s+/).filter(Boolean).slice(0, 8)) {
          where.push("(subject LIKE ? OR from_name LIKE ? OR from_email LIKE ? OR to_json LIKE ? OR cc_json LIKE ? OR snippet LIKE ? OR body LIKE ?)");
          const t = `%${word.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
          params.push(t, t, t, t, t, t, t);
        }
      }
      const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit)) || 50));
      const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
      const w = where.join(" AND ");
      const [countRows, rows]: any[] = await Promise.all([
        queryDB(`SELECT COUNT(*) AS n, SUM(is_read = 0) AS unread FROM mail_messages WHERE ${w}`, params),
        queryDB(`SELECT ${LIST_COLS} FROM mail_messages WHERE ${w} ORDER BY mail_date DESC, id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params)
      ]);
      res.json({ items: rows.map((r: any) => toApi(r, false)), total: Number(countRows[0]?.n || 0), unread: Number(countRows[0]?.unread || 0), page, limit });
    })
  );

  // Search the mail server itself. A mailbox comes in with only its latest
  // INITIAL_SYNC mails, so older mail could never be found from here.
  // Matches not stored yet are fetched like any other mail (newest first,
  // up to 50 a search); the list's own search then shows them.
  const SERVER_SEARCH_MAX = 50;
  app.post(
    "/api/mail/search-server",
    ...gate,
    handler(async (req, res) => {
      const q = str(req.body?.q, 200).trim();
      const label = str(req.body?.label, 60) || "Inbox";
      const roles = label === "Inbox" ? ["inbox"] : label === "Sent" ? ["sent"] : label === "Spam" ? ["junk"] : ["All", "Starred", "Important"].includes(label) ? ["inbox", "sent"] : [];
      if (q.length < 2 || !roles.length) return res.json({ added: 0 });
      const list = req.body?.accountId ? [await accountOf(uid(req), req.body.accountId)] : await accountsOf(uid(req));
      let added = 0;
      const errors: string[] = [];
      for (const a of list) {
        if (isInternalBox(a)) continue;
        try {
          const work = withAccountLock(Number(a.id), () =>
            withImap(a, async (c) => {
              const folders = await foldersOf(a, c);
              for (const role of roles) {
                const path = folders[role];
                if (!path) continue;
                const lock = await c.getMailboxLock(path);
                try {
                  // The mail server gets the longest word (IMAP can't AND several
                  // either-or tests); the list's own search then needs every word.
                  const word = q.split(/\s+/).filter(Boolean).sort((x, y) => y.length - x.length)[0];
                  const found: any = await c.search({ or: [{ subject: word }, { from: word }, { to: word }, { body: word }] }, { uid: true }).catch(() => false);
                  const uids: number[] = Array.isArray(found) ? found.map(Number) : [];
                  if (!uids.length) continue;
                  const have = new Set<number>();
                  for (let i = 0; i < uids.length; i += 500) {
                    const part = uids.slice(i, i + 500);
                    const rows: any[] = await queryDB(
                      `SELECT uid FROM mail_messages WHERE account_id = ? AND folder_role = ? AND uid IN (${part.map(() => "?").join(",")})`,
                      [Number(a.id), role, ...part]
                    );
                    for (const r of rows) have.add(Number(r.uid));
                  }
                  const missing = uids.filter((u) => !have.has(u)).sort((x, y) => y - x).slice(0, SERVER_SEARCH_MAX);
                  if (!missing.length) continue;
                  const msgs: any[] = [];
                  for await (const m of c.fetch(missing.join(","), { uid: true, envelope: true, flags: true, source: true, internalDate: true }, { uid: true })) msgs.push(m);
                  for (const m of msgs) if (await storeFetched(a, role, m, false)) added++;
                } finally {
                  lock.release();
                }
              }
            })
          );
          // A slow server: answer anyway; the mail still lands for the next look.
          await Promise.race([work, new Promise((r) => setTimeout(r, 25_000))]);
        } catch (e: any) {
          errors.push(e?.status ? e.message : imapError(e));
        }
      }
      res.json({ added, errors });
    })
  );

  // Unread / item counts for the folder list.
  app.get(
    "/api/mail/counts",
    ...gate,
    handler(async (req, res) => {
      const params: any[] = [uid(req)];
      let acc = "";
      if (req.query.accountId) {
        await accountOf(uid(req), req.query.accountId);
        acc = " AND account_id = ?";
        params.push(Number(req.query.accountId));
      }
      const rows: any[] = await queryDB(
        `SELECT
           SUM(labels_json LIKE '%"Inbox"%' AND labels_json NOT LIKE '%"Trash"%' AND labels_json NOT LIKE '%"Spam"%' AND is_read = 0) AS inbox_unread,
           SUM(labels_json LIKE '%"Spam"%' AND labels_json NOT LIKE '%"Trash"%' AND is_read = 0) AS spam_unread,
           SUM(labels_json LIKE '%"Drafts"%' AND labels_json NOT LIKE '%"Trash"%') AS drafts,
           SUM(labels_json LIKE '%"Scheduled"%') AS scheduled,
           SUM(is_starred = 1 AND labels_json NOT LIKE '%"Trash"%') AS starred
         FROM mail_messages WHERE user_id = ?${acc}`,
        params
      );
      const r = rows[0] || {};
      res.json({ inboxUnread: Number(r.inbox_unread || 0), spamUnread: Number(r.spam_unread || 0), drafts: Number(r.drafts || 0), scheduled: Number(r.scheduled || 0), starred: Number(r.starred || 0) });
    })
  );

  app.get(
    "/api/mail/messages/:id",
    ...gate,
    handler(async (req, res) => res.json(toApi(await messageOf(uid(req), req.params.id), true)))
  );

  // The whole conversation (same thread), oldest first.
  app.get(
    "/api/mail/threads/:threadId",
    ...gate,
    handler(async (req, res) => {
      const rows: any[] = await queryDB(
        "SELECT * FROM mail_messages WHERE user_id = ? AND thread_id = ? AND labels_json NOT LIKE '%\"Trash\"%' ORDER BY mail_date ASC, id ASC LIMIT 100",
        [uid(req), str(req.params.threadId, 64)]
      );
      res.json(rows.map((r) => toApi(r, true)));
    })
  );

  // One attachment: from the saved copy (mail written here) or fetched from
  // the mail server (mail received).
  app.get(
    "/api/mail/messages/:id/attachments/:idx",
    ...gate,
    handler(async (req, res) => {
      const m = await messageOf(uid(req), req.params.id, false);
      const idx = Number(req.params.idx);
      const meta = parseJson<any[]>(m.attachments_json, []).find((x) => Number(x.idx) === idx);
      if (!meta) throw bad("Attachment not found.", 404);
      const send = (buf: Buffer, name: string, type: string) => {
        const safe = name.replace(/[^\w.\- ()]+/g, "_");
        res.setHeader("Content-Type", type || "application/octet-stream");
        res.setHeader("Content-Disposition", `${req.query.inline ? "inline" : "attachment"}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.send(buf);
      };
      const local: any[] = await queryDB(
        "SELECT f.name, f.mime, COALESCE(f.data, b.data) AS data FROM mail_files f LEFT JOIN mail_blobs b ON b.id = f.blob_id WHERE f.message_id = ? AND f.idx = ?",
        [Number(m.id), idx]
      );
      if (local[0]?.data) return send(Buffer.isBuffer(local[0].data) ? local[0].data : Buffer.from(local[0].data), local[0].name, local[0].mime);
      if (!m.uid || !m.folder_role) throw bad("This attachment is no longer available.", 404);
      const a = await accountOf(uid(req), m.account_id);
      const content = await withImap(a, async (c) => {
        const folders = await foldersOf(a, c);
        const path = folders[m.folder_role];
        if (!path) return null;
        const lock = await c.getMailboxLock(path);
        try {
          const msg: any = await c.fetchOne(String(m.uid), { source: true }, { uid: true });
          if (!msg?.source) return null;
          const parsed: any = await simpleParser(msg.source);
          return parsed.attachments?.[idx] || null;
        } finally {
          lock.release();
        }
      });
      if (!content?.content) throw bad("This attachment is no longer on the mail server.", 404);
      send(content.content, meta.name, meta.type);
    })
  );

  // Read / star / important / labels / category — also on the mail server.
  async function applyPatch(userId: number, row: any, patch: any) {
    const sets: string[] = [];
    const vals: any[] = [];
    const flagSet: { read?: boolean; star?: boolean } = {};
    if (patch.isRead !== undefined) {
      sets.push("is_read = ?");
      vals.push(patch.isRead ? 1 : 0);
      flagSet.read = !!patch.isRead;
    }
    if (patch.isStarred !== undefined) {
      sets.push("is_starred = ?");
      vals.push(patch.isStarred ? 1 : 0);
      flagSet.star = !!patch.isStarred;
    }
    if (patch.isImportant !== undefined) {
      sets.push("is_important = ?");
      vals.push(patch.isImportant ? 1 : 0);
    }
    if (patch.category !== undefined) {
      sets.push("category = ?");
      vals.push(str(patch.category, 30) || "primary");
    }
    let newRole: string | null | undefined;
    if (Array.isArray(patch.labels)) {
      const labels = [...new Set(patch.labels.map((l: any) => String(l).slice(0, 60)).filter(Boolean))].slice(0, 30) as string[];
      sets.push("labels_json = ?");
      vals.push(JSON.stringify(labels));
      newRole = roleForLabels(labels, row.folder_role);
    }
    const a = await accountOf(userId, row.account_id);
    if (Object.keys(flagSet).length) await serverFlags(a, row, flagSet).catch((e) => console.warn("⚠️ Credence Mail flags:", e?.message));
    if (newRole && newRole !== row.folder_role && row.uid) {
      const moved = await serverMove(a, row, newRole).catch((e) => {
        console.warn("⚠️ Credence Mail move:", e?.message);
        return undefined;
      });
      if (moved !== undefined) {
        sets.push("folder_role = ?", "uid = ?");
        vals.push(newRole, moved);
      }
    }
    if (sets.length) await queryDB(`UPDATE mail_messages SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, [...vals, Number(row.id), userId]);
  }

  app.patch(
    "/api/mail/messages/:id",
    ...gate,
    handler(async (req, res) => {
      const row = await messageOf(uid(req), req.params.id, false);
      await applyPatch(uid(req), row, req.body || {});
      res.json(toApi(await messageOf(uid(req), row.id, false), false));
    })
  );

  // Delete: to Trash first; from Trash (or a draft / scheduled mail) for good.
  // In Trash already (or a draft / scheduled mail that only lives here): gone for good.
  const deletesForGood = (row: any) => {
    const labels = parseJson<string[]>(row.labels_json, []);
    return labels.includes("Trash") || (!row.uid && (labels.includes("Drafts") || labels.includes("Scheduled")));
  };
  const toTrashLabels = (row: any) => [...parseJson<string[]>(row.labels_json, []).filter((l) => l !== "Inbox" && l !== "Spam" && l !== "Archive"), "Trash"];
  async function deleteOne(userId: number, row: any) {
    const labels = parseJson<string[]>(row.labels_json, []);
    if (deletesForGood(row)) {
      if (row.uid) {
        const a = await accountOf(userId, row.account_id);
        await serverDelete(a, row).catch((e) => console.warn("⚠️ Credence Mail delete:", e?.message));
      }
      await queryDB("DELETE FROM mail_files WHERE message_id = ?", [Number(row.id)]);
      await queryDB("DELETE FROM mail_messages WHERE id = ? AND user_id = ?", [Number(row.id), userId]);
      return;
    }
    await applyPatch(userId, row, { labels: toTrashLabels(row) });
  }

  app.delete(
    "/api/mail/messages/:id",
    ...gate,
    handler(async (req, res) => {
      await deleteOne(uid(req), await messageOf(uid(req), req.params.id, false));
      res.json({ success: true });
    })
  );

  // Many at once. One mail-server login per mailbox folder for the whole
  // selection — logging in once per mail made "select 30, Delete" take
  // minutes on a real server, run into the proxy's timeout and trip the
  // server's login limit, so the mails never went.
  async function onServerFolder(userId: number, accountId: number, role: string, fn: (c: ImapFlow, folders: Record<string, string>) => Promise<void>) {
    const a = await accountOf(userId, accountId);
    await withAccountLock(Number(a.id), () =>
      withImap(a, async (c) => {
        const folders = await foldersOf(a, c);
        const path = folders[role];
        if (!path) return;
        const lock = await c.getMailboxLock(path);
        try {
          await fn(c, folders);
        } finally {
          lock.release();
        }
      })
    );
  }
  const byServerFolder = <T extends { r: any }>(list: T[], extraKey: (x: T) => string = () => "") => {
    const groups = new Map<string, T[]>();
    for (const x of list) {
      if (!x.r.uid || !x.r.folder_role) continue;
      const k = `${x.r.account_id}|${x.r.folder_role}|${extraKey(x)}`;
      groups.set(k, [...(groups.get(k) || []), x]);
    }
    return [...groups.values()];
  };
  const uidList = (list: { r: any }[]) => list.map((x) => Number(x.r.uid)).join(",");

  async function moveMany(userId: number, rows: any[], labelsFor: (r: any) => string[]) {
    const plan = rows.map((r) => {
      const labels = labelsFor(r);
      return { r, labels, role: roleForLabels(labels, r.folder_role) };
    });
    const moved = new Map<number, number | null>();
    for (const g of byServerFolder(plan.filter((x) => x.role && x.role !== x.r.folder_role), (x) => String(x.role))) {
      const toRole = String(g[0].role);
      await onServerFolder(userId, Number(g[0].r.account_id), g[0].r.folder_role, async (c, folders) => {
        if (!folders[toRole]) return;
        const res: any = await c.messageMove(uidList(g), folders[toRole], { uid: true });
        const map: Map<number, number> | undefined = res?.uidMap;
        for (const x of g) moved.set(Number(x.r.id), map?.get(Number(x.r.uid)) ?? null);
      }).catch((e) => console.warn("⚠️ Credence Mail move:", e?.message));
    }
    for (const x of plan) {
      const id = Number(x.r.id);
      if (moved.has(id)) await queryDB("UPDATE mail_messages SET labels_json = ?, folder_role = ?, uid = ? WHERE id = ? AND user_id = ?", [JSON.stringify(x.labels), x.role, moved.get(id), id, userId]);
      else await queryDB("UPDATE mail_messages SET labels_json = ? WHERE id = ? AND user_id = ?", [JSON.stringify(x.labels), id, userId]);
    }
  }

  async function deleteMany(userId: number, rows: any[]) {
    const gone = rows.filter(deletesForGood);
    for (const g of byServerFolder(gone.map((r) => ({ r })))) {
      await onServerFolder(userId, Number(g[0].r.account_id), g[0].r.folder_role, async (c) => {
        await c.messageDelete(uidList(g), { uid: true });
      }).catch((e) => console.warn("⚠️ Credence Mail delete:", e?.message));
    }
    if (gone.length) {
      const ids = gone.map((r) => Number(r.id));
      const marks = ids.map(() => "?").join(",");
      await queryDB(`DELETE FROM mail_files WHERE message_id IN (${marks})`, ids);
      await queryDB(`DELETE FROM mail_messages WHERE user_id = ? AND id IN (${marks})`, [userId, ...ids]);
    }
    await moveMany(userId, rows.filter((r) => !deletesForGood(r)), toTrashLabels);
  }

  async function flagMany(userId: number, rows: any[], patch: any) {
    const sets: string[] = [];
    const vals: any[] = [];
    const flags: [string, boolean][] = [];
    if (patch.isRead !== undefined) {
      sets.push("is_read = ?");
      vals.push(patch.isRead ? 1 : 0);
      flags.push(["\\Seen", !!patch.isRead]);
    }
    if (patch.isStarred !== undefined) {
      sets.push("is_starred = ?");
      vals.push(patch.isStarred ? 1 : 0);
      flags.push(["\\Flagged", !!patch.isStarred]);
    }
    if (patch.isImportant !== undefined) {
      sets.push("is_important = ?");
      vals.push(patch.isImportant ? 1 : 0);
    }
    if (patch.category !== undefined) {
      sets.push("category = ?");
      vals.push(str(patch.category, 30) || "primary");
    }
    if (flags.length) {
      for (const g of byServerFolder(rows.map((r) => ({ r })))) {
        await onServerFolder(userId, Number(g[0].r.account_id), g[0].r.folder_role, async (c) => {
          for (const [flag, on] of flags) await (on ? c.messageFlagsAdd(uidList(g), [flag], { uid: true }) : c.messageFlagsRemove(uidList(g), [flag], { uid: true }));
        }).catch((e) => console.warn("⚠️ Credence Mail flags:", e?.message));
      }
    }
    if (sets.length) {
      const ids = rows.map((r) => Number(r.id));
      await queryDB(`UPDATE mail_messages SET ${sets.join(", ")} WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`, [...vals, userId, ...ids]);
    }
  }

  // { ids, action: "delete" }  — to Trash, or for good from Trash
  // { ids, action: "move", to: "Inbox" | "Spam" | "Archive" }
  // { ids, patch: { isRead, isStarred, isImportant, category } }
  app.post(
    "/api/mail/messages/batch",
    ...gate,
    handler(async (req, res) => {
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n: number) => n > 0).slice(0, 500);
      if (!ids.length) return res.json({ success: true, done: 0 });
      const rows: any[] = await queryDB(`SELECT ${LIST_COLS}, folder_role, uid FROM mail_messages WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`, [uid(req), ...ids]);
      const action = req.body?.action;
      if (action === "delete") await deleteMany(uid(req), rows);
      else if (action === "move") {
        const to = String(req.body?.to || "");
        if (!["Inbox", "Spam", "Archive"].includes(to)) throw bad("Move to Inbox, Spam or Archive.");
        await moveMany(uid(req), rows, (r) => [...parseJson<string[]>(r.labels_json, []).filter((l) => !["Inbox", "Spam", "Trash", "Archive"].includes(l)), to]);
      } else {
        const patch = req.body?.patch || {};
        if (Array.isArray(patch.labels)) for (const r of rows) await applyPatch(uid(req), r, patch);
        else await flagMany(uid(req), rows, patch);
      }
      res.json({ success: true, done: rows.length });
    })
  );

  // ---- Writing ------------------------------------------------------------
  type InFile = { name: string; type: string; data: Buffer };
  function filesFrom(list: any): InFile[] {
    if (!Array.isArray(list)) return [];
    let total = 0;
    const out: InFile[] = [];
    for (const f of list.slice(0, 20)) {
      const dataUrl = String(f?.dataUrl || "");
      const b64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
      if (!b64) continue;
      const data = Buffer.from(b64, "base64");
      total += data.length;
      if (total > 15 * 1024 * 1024) throw bad("Attachments can be at most 15 MB in total.");
      out.push({ name: str(f.name, 255) || "attachment", type: str(f.type, 150) || "application/octet-stream", data });
    }
    return out;
  }
  async function saveFiles(messageId: number, files: InFile[], keep: any[] = []) {
    await queryDB("DELETE FROM mail_files WHERE message_id = ?", [messageId]);
    const meta: any[] = [];
    let idx = 0;
    for (const k of keep) {
      await queryDB("INSERT INTO mail_files (message_id, idx, name, mime, size, data) VALUES (?, ?, ?, ?, ?, ?)", [messageId, idx, k.name, k.mime, k.data.length, k.data]);
      meta.push({ idx, name: k.name, type: k.mime, size: k.data.length });
      idx++;
    }
    for (const f of files) {
      await queryDB("INSERT INTO mail_files (message_id, idx, name, mime, size, data) VALUES (?, ?, ?, ?, ?, ?)", [messageId, idx, f.name, f.type, f.data.length, f.data]);
      meta.push({ idx, name: f.name, type: f.type, size: f.data.length });
      idx++;
    }
    await queryDB("UPDATE mail_messages SET attachments_json = ?, has_attachments = ? WHERE id = ?", [JSON.stringify(meta), meta.length ? 1 : 0, messageId]);
  }
  async function storedFiles(messageId: number) {
    return ((await queryDB("SELECT f.name, f.mime, COALESCE(f.data, b.data) AS data FROM mail_files f LEFT JOIN mail_blobs b ON b.id = f.blob_id WHERE f.message_id = ? ORDER BY f.idx", [messageId])) || []).map((f: any) => ({
      name: f.name,
      mime: f.mime,
      data: Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data || "")
    }));
  }

  // Builds the message once: the same bytes go to SMTP and into Sent.
  const newMessageId = (a: any) => `<${crypto.randomUUID()}@${String(a.email).split("@")[1] || "credence.mail"}>`;
  async function compose(a: any, m: { messageId?: string | null; to: string[]; cc: string[]; bcc: string[]; subject: string; html: string; inReplyTo?: string | null; references?: string | null; files: { name: string; mime: string; data: Buffer }[] }) {
    const messageId = m.messageId || newMessageId(a);
    const raw = await new MailComposer({
      from: { name: a.display_name || a.email, address: a.email },
      to: m.to.join(", ") || undefined,
      cc: m.cc.join(", ") || undefined,
      bcc: m.bcc.join(", ") || undefined,
      subject: m.subject,
      html: m.html,
      messageId,
      inReplyTo: m.inReplyTo || undefined,
      references: m.references || m.inReplyTo || undefined,
      attachments: m.files.map((f) => ({ filename: f.name, content: f.data, contentType: f.mime }))
    })
      .compile()
      .build();
    return { raw, messageId };
  }
  // Sends a saved row (send now / scheduled / draft) and files it as Sent.
  async function deliver(a: any, row: any) {
    const to = parseJson<string[]>(row.to_json, []);
    const cc = parseJson<string[]>(row.cc_json, []);
    const bcc = parseJson<string[]>(row.bcc_json, []);
    const files = await storedFiles(Number(row.id));
    const { raw, messageId } = await compose(a, { messageId: row.message_id, to, cc, bcc, subject: row.subject || "", html: row.body || "", inReplyTo: row.in_reply_to, references: row.refs, files });
    const routed = await sendRouted(a, [...to, ...cc, ...bcc], raw, {
      messageId,
      inReplyTo: row.in_reply_to || null,
      refs: row.refs || row.in_reply_to || null,
      to,
      cc,
      subject: row.subject || "",
      html: row.body || "",
      files
    });
    // A copy in the server's Sent folder (other mail apps see it too) — only
    // when it went out through the server; mail that stayed inside
    // CredenceHR is kept here only.
    let sentUid: number | null = null;
    if (routed.external.length) {
      try {
        sentUid = await withImap(a, async (c) => {
          const folders = await foldersOf(a, c);
          if (!folders.sent) return null;
          const r: any = await c.append(folders.sent, raw, ["\\Seen"]);
          return r?.uid ? Number(r.uid) : null;
        });
      } catch (e: any) {
        console.warn("⚠️ Credence Mail: couldn't save to Sent on the server:", e?.message);
      }
    }
    await queryDB(
      `UPDATE mail_messages SET labels_json = ?, folder_role = 'sent', uid = ?, message_id = ?, mail_date = UTC_TIMESTAMP(), scheduled_at = NULL, send_error = NULL, is_read = 1, via_internal = ? WHERE id = ?`,
      [JSON.stringify(["Sent"]), sentUid, messageId, routed.external.length ? 0 : 1, Number(row.id)]
    );
    // The server has the attachments now (Sent copy); keep ours only if it doesn't.
    if (sentUid) await queryDB("DELETE FROM mail_files WHERE message_id = ?", [Number(row.id)]);
    else if (routed.blobs.length) {
      // Kept here: point at the one shared copy instead of a second one.
      const ids = routed.blobs;
      for (let i = 0; i < ids.length; i++) await queryDB("UPDATE mail_files SET data = NULL, blob_id = ? WHERE message_id = ? AND idx = ?", [ids[i], Number(row.id), i]);
    }
    return { internal: routed.internal.length, external: routed.external.length };
  }

  // Saves the composer's content as a local row (draft / scheduled / outgoing).
  async function upsertLocal(userId: number, b: any, labels: string[], existingId?: number) {
    const a = await accountOf(userId, b.accountId);
    const to = splitAddresses(b.to);
    const cc = splitAddresses(b.cc);
    const bcc = splitAddresses(b.bcc);
    const subject = str(b.subject, 2000) || "(no subject)";
    const html = typeof b.body === "string" ? b.body.slice(0, 5_000_000) : "";
    const text = html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    const scheduledAt = labels.includes("Scheduled") && b.scheduledAt ? toDb(b.scheduledAt) : null;
    const inReplyTo = str(b.inReplyTo, 500) || null;
    // The Message-ID is fixed when the mail is first saved, so the thread
    // (rooted at the first mail's Message-ID) is the same one the
    // recipients' replies will point back to.
    let messageId: string | null = null;
    if (existingId) messageId = (((await queryDB("SELECT message_id FROM mail_messages WHERE id = ? AND user_id = ?", [existingId, userId])) || [])[0] || {}).message_id || null;
    if (!messageId) messageId = newMessageId(a);
    // A reply carries the whole chain of the mail it answers.
    let refs: string | null = null;
    if (inReplyTo) {
      const orig: any = ((await queryDB("SELECT refs FROM mail_messages WHERE user_id = ? AND message_id = ? LIMIT 1", [userId, inReplyTo])) || [])[0];
      refs = [...refList(orig?.refs), inReplyTo].filter((x, i, all) => all.indexOf(x) === i).join(" ").slice(0, 4000);
    }
    const thread = threadOf(messageId, inReplyTo, refs);
    let id = existingId;
    if (id) {
      await queryDB(
        `UPDATE mail_messages SET account_id = ?, to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body = ?, snippet = ?, labels_json = ?, scheduled_at = ?, in_reply_to = ?, refs = ?, message_id = ?, thread_id = ?, mail_date = UTC_TIMESTAMP(), from_email = ?, from_name = ? WHERE id = ? AND user_id = ?`,
        [Number(a.id), JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, html, text.slice(0, 200), JSON.stringify(labels), scheduledAt, inReplyTo, refs, messageId, thread, a.email, a.display_name || a.email, id, userId]
      );
    } else {
      const r: any = await queryDB(
        `INSERT INTO mail_messages (user_id, account_id, folder_role, uid, message_id, thread_id, in_reply_to, refs, from_name, from_email, to_json, cc_json, bcc_json, subject, body, snippet, mail_date, is_read, labels_json, category, attachments_json, scheduled_at)
         VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), 1, ?, 'primary', '[]', ?)`,
        [userId, Number(a.id), messageId, thread, inReplyTo, refs, a.display_name || a.email, a.email, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, html, text.slice(0, 200), JSON.stringify(labels), scheduledAt]
      );
      id = Number(r.insertId);
    }
    return { a, id: id!, to, cc, bcc };
  }
  // Keeps attachments of the draft being sent ("keepAttachments": idx list)
  // plus the new ones.
  async function attachFor(id: number, b: any, previousId?: number) {
    const keepIdx: number[] = Array.isArray(b.keepAttachments) ? b.keepAttachments.map(Number) : [];
    const keep = previousId ? (await storedFiles(previousId)).filter((_: any, i: number) => keepIdx.includes(i)) : [];
    const files = filesFrom(b.attachments);
    if (keep.length || files.length || previousId) await saveFiles(id, files, keep);
  }

  // Send now, or later (scheduledAt) — { accountId, to, cc, bcc, subject,
  // body, attachments: [{ name, type, dataUrl }], inReplyTo,
  // draftId, keepAttachments }
  app.post(
    "/api/mail/send",
    ...gate,
    handler(async (req, res) => {
      const b = req.body || {};
      const draftId = b.draftId ? Number(b.draftId) : undefined;
      if (draftId) await messageOf(uid(req), draftId, false);
      const later = b.scheduledAt && new Date(b.scheduledAt).getTime() > Date.now() + 30_000;
      if (b.scheduledAt && Number.isNaN(new Date(b.scheduledAt).getTime())) throw bad("Pick a valid time to send.");
      const { a, id, to, cc, bcc } = await upsertLocal(uid(req), b, later ? ["Scheduled"] : ["Outbox"], draftId);
      if (!to.length && !cc.length && !bcc.length) {
        if (!draftId) await queryDB("DELETE FROM mail_messages WHERE id = ?", [id]);
        throw bad("Add at least one recipient.");
      }
      await attachFor(id, b, draftId);
      if (later) {
        res.status(201).json(toApi(await messageOf(uid(req), id), false));
        return;
      }
      let delivery: { internal: number; external: number } | undefined;
      try {
        delivery = await deliver(a, await messageOf(uid(req), id));
      } catch (e: any) {
        const msg = `Not sent: ${e?.response || e?.message || e}`;
        await queryDB("UPDATE mail_messages SET labels_json = ?, send_error = ? WHERE id = ?", [JSON.stringify(["Drafts"]), msg.slice(0, 500), id]);
        throw bad(`${msg}. It was kept in Drafts.`, 502);
      }
      io.to(`user:${uid(req)}`).emit("mail:changed", { accountId: Number(a.id) });
      res.status(201).json({ ...toApi(await messageOf(uid(req), id), false), delivery });
    })
  );

  // Save a draft (new or the same one again).
  app.post(
    "/api/mail/drafts",
    ...gate,
    handler(async (req, res) => {
      const b = req.body || {};
      const existing = b.id ? Number(b.id) : undefined;
      if (existing) {
        const row = await messageOf(uid(req), existing, false);
        if (!parseJson<string[]>(row.labels_json, []).includes("Drafts")) throw bad("Only drafts can be changed.");
      }
      const { id } = await upsertLocal(uid(req), b, ["Drafts"], existing);
      if (Array.isArray(b.attachments) || Array.isArray(b.keepAttachments)) await attachFor(id, b, existing);
      res.json(toApi(await messageOf(uid(req), id), false));
    })
  );

  // A scheduled mail back to Drafts (cancel sending).
  app.post(
    "/api/mail/messages/:id/unschedule",
    ...gate,
    handler(async (req, res) => {
      const row = await messageOf(uid(req), req.params.id, false);
      const r: any = await queryDB("UPDATE mail_messages SET labels_json = ?, scheduled_at = NULL WHERE id = ? AND user_id = ? AND labels_json LIKE '%\"Scheduled\"%'", [
        JSON.stringify(["Drafts"]),
        Number(row.id),
        uid(req)
      ]);
      if (!Number(r?.affectedRows)) throw bad("This mail has already been sent.", 409);
      res.json(toApi(await messageOf(uid(req), row.id), false));
    })
  );

  // ---- Settings, templates, rules, contacts, tasks, events ---------------
  app.get(
    "/api/mail/settings",
    ...gate,
    handler(async (req, res) => res.json(await settingsOf(uid(req))))
  );
  app.put(
    "/api/mail/settings",
    ...gate,
    handler(async (req, res) => {
      const cur = await settingsOf(uid(req));
      const b = req.body || {};
      const next = {
        signatures: Array.isArray(b.signatures)
          ? b.signatures.slice(0, 20).map((s: any) => ({
              id: str(s.id, 60) || crypto.randomUUID(),
              name: str(s.name, 120) || "Signature",
              content: String(s.content || "").slice(0, 200_000),
              isDefault: !!s.isDefault,
              // The signature maker's fields, so it can be edited again.
              fields: s.fields && typeof s.fields === "object"
                ? { fullName: str(s.fields.fullName, 120), title: str(s.fields.title, 120), department: str(s.fields.department, 120), mobile: str(s.fields.mobile, 60), pabx: str(s.fields.pabx, 30) }
                : undefined,
              logoUrl: /^(https?:\/\/[^\s"'<>]+)?\/api\/mail\/public\/signature\/\d+\/[0-9a-f]{32}$/.test(String(s.logoUrl || "")) ? String(s.logoUrl) : undefined
            }))
          : cur.signatures,
        vacationResponder:
          b.vacationResponder && typeof b.vacationResponder === "object"
            ? { enabled: !!b.vacationResponder.enabled, subject: str(b.vacationResponder.subject, 500), message: String(b.vacationResponder.message || "").slice(0, 10_000), startDate: str(b.vacationResponder.startDate, 40) || undefined, endDate: str(b.vacationResponder.endDate, 40) || undefined }
            : cur.vacationResponder,
        blockedSenders: Array.isArray(b.blockedSenders) ? [...new Set(b.blockedSenders.map((x: any) => str(x, 255).toLowerCase()).filter(Boolean))].slice(0, 500) : cur.blockedSenders,
        pictureSenders: Array.isArray(b.pictureSenders) ? [...new Set(b.pictureSenders.map((x: any) => str(x, 255).toLowerCase()).filter(Boolean))].slice(0, 500) : cur.pictureSenders,
        layout:
          b.layout && typeof b.layout === "object" && !Array.isArray(b.layout)
            ? { density: b.layout.density === "compact" ? "compact" : "comfortable", previewPane: str(b.layout.previewPane, 20) || "right", theme: str(b.layout.theme, 20) || "light" }
            : cur.layout,
        language: str(b.language, 50) || cur.language,
        timezone: str(b.timezone, 80) || cur.timezone
      };
      await queryDB(
        `INSERT INTO mail_settings (user_id, signatures_json, vacation_json, blocked_json, picture_senders_json, layout_json, language, timezone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE signatures_json = VALUES(signatures_json), vacation_json = VALUES(vacation_json), blocked_json = VALUES(blocked_json),
           picture_senders_json = VALUES(picture_senders_json), layout_json = VALUES(layout_json), language = VALUES(language), timezone = VALUES(timezone)`,
        [uid(req), JSON.stringify(next.signatures), JSON.stringify(next.vacationResponder), JSON.stringify(next.blockedSenders), JSON.stringify(next.pictureSenders), JSON.stringify(next.layout), next.language, next.timezone]
      );
      res.json(next);
    })
  );

  // Signature pictures (logo): kept in the database; the picture's address
  // carries a random token so recipients' mail apps can show it.
  app.post(
    "/api/mail/signature-images",
    ...gate,
    handler(async (req, res) => {
      const m = /^data:(image\/(png|jpe?g|gif|webp));base64,(.+)$/i.exec(String(req.body?.dataUrl || ""));
      if (!m) throw bad("Pick a PNG, JPG, GIF or WebP picture.");
      const data = Buffer.from(m[3], "base64");
      if (data.length > 1024 * 1024) throw bad("The picture can be at most 1 MB.");
      const token = crypto.randomBytes(16).toString("hex");
      const r: any = await queryDB("INSERT INTO mail_signature_images (user_id, token, mime, data) VALUES (?, ?, ?, ?)", [uid(req), token, m[1].toLowerCase(), data]);
      res.status(201).json({ id: Number(r.insertId), url: `/api/mail/public/signature/${Number(r.insertId)}/${token}` });
    })
  );
  app.delete(
    "/api/mail/signature-images/:id",
    ...gate,
    handler(async (req, res) => {
      await queryDB("DELETE FROM mail_signature_images WHERE id = ? AND user_id = ?", [Number(req.params.id), uid(req)]);
      res.json({ success: true });
    })
  );
  app.get("/api/mail/public/signature/:id/:token", async (req: any, res: any) => {
    try {
      if (!isMySQL()) return res.status(404).end();
      const rows: any[] = await queryDB("SELECT mime, data, token FROM mail_signature_images WHERE id = ?", [Number(req.params.id)]);
      const r = rows[0];
      const given = String(req.params.token || "");
      if (!r || given.length !== 32 || !crypto.timingSafeEqual(Buffer.from(r.token), Buffer.from(given))) return res.status(404).end();
      res.setHeader("Content-Type", r.mime);
      res.setHeader("Cache-Control", "public, max-age=604800");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data));
    } catch {
      res.status(404).end();
    }
  });

  // Simple per-user lists (templates, contacts, tasks, events, rules).
  const crud = (path: string, table: string, toRow: (b: any) => Record<string, any>, toOut: (r: any) => any, order = "id DESC") => {
    app.get(
      `/api/mail/${path}`,
      ...gate,
      handler(async (req, res) => res.json(((await queryDB(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY ${order} LIMIT 1000`, [uid(req)])) || []).map(toOut)))
    );
    app.post(
      `/api/mail/${path}`,
      ...gate,
      handler(async (req, res) => {
        const row = toRow(req.body || {});
        const cols = Object.keys(row);
        const r: any = await queryDB(`INSERT INTO ${table} (user_id, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})`, [uid(req), ...cols.map((c) => row[c])]);
        const saved: any[] = await queryDB(`SELECT * FROM ${table} WHERE id = ?`, [Number(r.insertId)]);
        res.status(201).json(toOut(saved[0]));
      })
    );
    const update = handler(async (req, res) => {
      const old: any[] = await queryDB(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`, [Number(req.params.id), uid(req)]);
      if (!old[0]) throw bad("Not found.", 404);
      const merged = { ...toOut(old[0]), ...(req.body || {}) };
      const row = toRow(merged);
      const cols = Object.keys(row);
      await queryDB(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND user_id = ?`, [...cols.map((c) => row[c]), Number(req.params.id), uid(req)]);
      const saved: any[] = await queryDB(`SELECT * FROM ${table} WHERE id = ?`, [Number(req.params.id)]);
      res.json(toOut(saved[0]));
    });
    app.patch(`/api/mail/${path}/:id`, ...gate, update);
    app.put(`/api/mail/${path}/:id`, ...gate, update);
    app.delete(
      `/api/mail/${path}/:id`,
      ...gate,
      handler(async (req, res) => {
        await queryDB(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`, [Number(req.params.id), uid(req)]);
        res.json({ success: true });
      })
    );
  };
  crud(
    "templates",
    "mail_templates",
    (b) => {
      if (!str(b.title)) throw bad("Give the template a name.");
      return { title: str(b.title), subject: str(b.subject, 500), body: String(b.body || "").slice(0, 2_000_000) };
    },
    (r) => ({ id: String(r.id), title: r.title, subject: r.subject || "", body: r.body || "" })
  );
  crud(
    "filters",
    "mail_filters",
    (b) => {
      if (!str(b.name)) throw bad("Give the rule a name.");
      const c = b.conditions || {};
      const ac = b.actions || {};
      return {
        name: str(b.name),
        conditions_json: JSON.stringify({ from: str(c.from), to: str(c.to), subjectContains: str(c.subjectContains), bodyContains: str(c.bodyContains), hasAttachment: !!c.hasAttachment }),
        actions_json: JSON.stringify({
          archive: !!ac.archive,
          markRead: !!ac.markRead,
          star: !!ac.star,
          applyLabels: (Array.isArray(ac.applyLabels) ? ac.applyLabels : ac.applyLabel ? [ac.applyLabel] : []).map((x: any) => str(x, 60)).filter(Boolean).slice(0, 10),
          categorize: str(ac.categorize, 30) || undefined
        }),
        is_active: b.isActive === false ? 0 : 1
      };
    },
    (r) => ({ id: String(r.id), name: r.name, conditions: parseJson(r.conditions_json, {}), actions: parseJson(r.actions_json, {}), isActive: !!Number(r.is_active) })
  );
  crud(
    "contacts",
    "mail_contacts",
    (b) => {
      if (!str(b.name) || !isEmail(str(b.email).toLowerCase())) throw bad("A contact needs a name and a valid email.");
      return { name: str(b.name), email: str(b.email).toLowerCase(), phone: str(b.phone, 80) || null, company: str(b.company) || null, notes: String(b.notes || "").slice(0, 5000) || null, avatar_color: str(b.avatarColor, 50) || null };
    },
    (r) => ({ id: String(r.id), name: r.name, email: r.email, phone: r.phone || "", company: r.company || "", notes: r.notes || "", avatarColor: r.avatar_color || "" }),
    "name ASC"
  );
  crud(
    "tasks",
    "mail_tasks",
    (b) => {
      if (!str(b.title, 500)) throw bad("A task needs a title.");
      return { title: str(b.title, 500), due_date: str(b.dueDate, 40) || null, completed: b.completed ? 1 : 0, email_id: Number(b.emailId) || null, email_subject: str(b.emailSubject, 500) || null };
    },
    (r) => ({ id: String(r.id), title: r.title, dueDate: r.due_date || undefined, completed: !!Number(r.completed), emailId: r.email_id ? String(r.email_id) : undefined, emailSubject: r.email_subject || undefined })
  );
  crud(
    "events",
    "mail_events",
    (b) => {
      if (!str(b.title, 500) || !str(b.start, 40) || !str(b.end, 40)) throw bad("An event needs a title, a start and an end.");
      return { title: str(b.title, 500), start_at: str(b.start, 40), end_at: str(b.end, 40), description: String(b.description || "").slice(0, 10_000) || null, location: str(b.location) || null, email_id: Number(b.emailId) || null };
    },
    (r) => ({ id: String(r.id), title: r.title, start: r.start_at, end: r.end_at, description: r.description || "", location: r.location || "", emailId: r.email_id ? String(r.email_id) : undefined }),
    "start_at ASC"
  );

  // Addresses for the composer: own contacts, people written with, and
  // CredenceHR colleagues (Employee Directory emails).
  app.get(
    "/api/mail/address-book",
    ...gate,
    handler(async (req, res) => {
      const q = str(req.query.q, 100).toLowerCase();
      const like = `%${q}%`;
      const out = new Map<string, { name: string; email: string; source: string }>();
      const add = (name: any, email: any, source: string) => {
        const e = String(email || "").trim().toLowerCase();
        if (!isEmail(e) || out.has(e)) return;
        out.set(e, { name: String(name || "").trim() || e.split("@")[0], email: e, source });
      };
      const [contacts, people, colleagues]: any[] = await Promise.all([
        queryDB("SELECT name, email FROM mail_contacts WHERE user_id = ? AND (name LIKE ? OR email LIKE ?) ORDER BY name LIMIT 20", [uid(req), like, like]),
        queryDB(
          "SELECT from_name AS name, from_email AS email, MAX(mail_date) AS last FROM mail_messages WHERE user_id = ? AND (from_name LIKE ? OR from_email LIKE ?) AND from_email <> '' GROUP BY from_email, from_name ORDER BY last DESC LIMIT 20",
          [uid(req), like, like]
        ),
        queryDB("SELECT name, email FROM all_employees WHERE email IS NOT NULL AND email <> '' AND is_active = 1 AND (name LIKE ? OR email LIKE ?) ORDER BY name LIMIT 20", [like, like]).catch(() => [])
      ]);
      for (const r of contacts || []) add(r.name, r.email, "contact");
      for (const r of colleagues || []) add(r.name, r.email, "colleague");
      for (const r of people || []) add(r.name, r.email, "recent");
      res.json([...out.values()].slice(0, 30));
    })
  );

  // Everyone in the Employee Directory who has an email, for the composer's
  // To / Cc / Bcc lists (queryDB keeps all_employees to the active company).
  app.get(
    "/api/mail/directory",
    ...gate,
    handler(async (_req, res) => {
      const rows: any[] =
        (await queryDB(
          "SELECT name, email, designation, department FROM all_employees WHERE is_active = 1 AND email IS NOT NULL AND email <> '' ORDER BY name LIMIT 10000"
        ).catch(() => [])) || [];
      const seen = new Set<string>();
      const out: { name: string; email: string; designation: string; department: string }[] = [];
      for (const r of rows) {
        const e = String(r.email || "").trim().toLowerCase();
        if (!isEmail(e) || seen.has(e)) continue;
        seen.add(e);
        out.push({ name: String(r.name || "").trim() || e.split("@")[0], email: e, designation: r.designation || "", department: r.department || "" });
      }
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json(out);
    })
  );

  // Numbers for the Analytics view (last 14 days).
  app.get(
    "/api/mail/analytics",
    ...gate,
    handler(async (req, res) => {
      const u = uid(req);
      const [totals, trend, top, cats, resp]: any[] = await Promise.all([
        queryDB(
          `SELECT SUM(labels_json LIKE '%"Sent"%') AS sent, SUM(labels_json LIKE '%"Inbox"%') AS received, SUM(labels_json LIKE '%"Spam"%') AS spam FROM mail_messages WHERE user_id = ?`,
          [u]
        ),
        queryDB(
          `SELECT DATE(mail_date) AS day, SUM(labels_json LIKE '%"Sent"%') AS sent, SUM(labels_json LIKE '%"Inbox"%') AS received
           FROM mail_messages WHERE user_id = ? AND mail_date >= UTC_TIMESTAMP() - INTERVAL 14 DAY GROUP BY DATE(mail_date) ORDER BY day`,
          [u]
        ),
        queryDB(
          `SELECT from_name AS name, from_email AS email, COUNT(*) AS n FROM mail_messages WHERE user_id = ? AND labels_json LIKE '%"Inbox"%' AND from_email <> '' GROUP BY from_email, from_name ORDER BY n DESC LIMIT 5`,
          [u]
        ),
        queryDB("SELECT category AS name, COUNT(*) AS n FROM mail_messages WHERE user_id = ? AND labels_json LIKE '%\"Inbox\"%' GROUP BY category", [u]),
        queryDB(
          `SELECT AVG(TIMESTAMPDIFF(MINUTE, r.mail_date, s.mail_date)) AS m FROM mail_messages r JOIN mail_messages s ON s.thread_id = r.thread_id AND s.user_id = r.user_id
           WHERE r.user_id = ? AND r.labels_json LIKE '%"Inbox"%' AND s.labels_json LIKE '%"Sent"%' AND s.mail_date > r.mail_date AND s.mail_date < r.mail_date + INTERVAL 7 DAY`,
          [u]
        )
      ]);
      const t = totals[0] || {};
      res.json({
        sentCount: Number(t.sent || 0),
        receivedCount: Number(t.received || 0),
        spamCount: Number(t.spam || 0),
        averageResponseTimeMinutes: Math.round(Number(resp[0]?.m || 0)),
        dailyTrends: trend.map((r: any) => ({ date: String(r.day).slice(0, 10), sent: Number(r.sent || 0), received: Number(r.received || 0) })),
        contactEngagement: top.map((r: any) => ({ name: r.name || r.email, email: r.email, count: Number(r.n || 0) })),
        categoryDistribution: cats.map((r: any) => ({ name: r.name, value: Number(r.n || 0) }))
      });
    })
  );

  // =========================================================================
  // Background (one worker only — jobRunner.ts)
  // =========================================================================
  // Live watchers: one IMAP IDLE connection per mailbox of people who are
  // online right now (any worker's sockets, via fetchSockets), capped.
  const MAX_IDLE = Math.max(0, Number(process.env.MAIL_MAX_IDLE) || 200);
  const idle = new Map<number, { client: ImapFlow; userId: number; offlineSince: number | null }>();
  function stopIdle(accountId: number) {
    const w = idle.get(accountId);
    if (!w) return;
    idle.delete(accountId);
    w.client.logout().catch(() => w.client.close());
  }
  async function startIdle(a: any) {
    const id = Number(a.id);
    if (idle.has(id) || idle.size >= MAX_IDLE) return;
    let c: ImapFlow;
    try {
      c = await openImap(a);
    } catch {
      return;
    }
    idle.set(id, { client: c, userId: Number(a.user_id), offlineSince: null });
    let pending: NodeJS.Timeout | null = null;
    c.on("exists", () => {
      // New mail: fetch it on a separate connection (debounced).
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        syncAndNotify(a, ["inbox"]).catch(() => undefined);
      }, 1500);
    });
    c.on("close", () => {
      if (idle.get(id)?.client === c) idle.delete(id);
    });
    try {
      await c.mailboxOpen("INBOX");
      // imapflow keeps the connection in IDLE by itself while nothing else runs.
    } catch {
      stopIdle(id);
      return;
    }
    // Mail that came in before the watcher started raises no "exists" — catch up once.
    syncAndNotify(a, ["inbox"]).catch(() => undefined);
  }
  async function onlineUserIds(): Promise<Set<number>> {
    try {
      const sockets = await io.fetchSockets();
      return new Set(sockets.map((s: any) => Number(s.data?.user?.id)).filter((n) => n > 0));
    } catch {
      return new Set();
    }
  }
  async function tickWatchers() {
    if (!isMySQL() || !mailKey()) return;
    const online = await onlineUserIds();
    const now = Date.now();
    for (const [id, w] of idle) {
      if (online.has(w.userId)) w.offlineSince = null;
      else if (!w.offlineSince) w.offlineSince = now;
      else if (now - w.offlineSince > 5 * 60_000) stopIdle(id);
    }
    if (!online.size) return;
    const ids = [...online];
    const accts: any[] =
      (await queryDB(
        `SELECT a.* FROM mail_accounts a JOIN users u ON u.id = a.user_id
         WHERE a.user_id IN (${ids.map(() => "?").join(",")}) AND (u.role = 'superadmin' OR u.can_use_mail = 1) AND (a.last_error IS NULL OR a.last_sync_at > UTC_TIMESTAMP() - INTERVAL 1 HOUR)`,
        ids
      ).catch(() => [])) || [];
    for (const a of accts) {
      if (idle.has(Number(a.id)) || isInternalBox(a)) continue;
      if (idle.size < MAX_IDLE) await startIdle(a);
      else {
        // Over the cap: a plain sync every few minutes instead.
        const last = a.last_sync_at ? new Date(fromDb(a.last_sync_at)!).getTime() : 0;
        if (now - last > 3 * 60_000) syncAndNotify(a, ["inbox"]).catch(() => undefined);
      }
    }
  }

  // Scheduled mail whose time has come.
  async function sendScheduled() {
    if (!isMySQL() || !mailKey()) return;
    const due: any[] = (await queryDB("SELECT * FROM mail_messages WHERE scheduled_at IS NOT NULL AND scheduled_at <= UTC_TIMESTAMP() AND labels_json LIKE '%\"Scheduled\"%' LIMIT 50").catch(() => [])) || [];
    for (const row of due) {
      // Claim it, so nothing sends it twice.
      const claim: any = await queryDB("UPDATE mail_messages SET labels_json = ? WHERE id = ? AND labels_json LIKE '%\"Scheduled\"%'", [JSON.stringify(["Outbox"]), Number(row.id)]);
      if (!Number(claim?.affectedRows)) continue;
      try {
        const a = await accountOf(Number(row.user_id), row.account_id);
        await deliver(a, row);
        io.to(`user:${Number(row.user_id)}`).emit("mail:changed", { accountId: Number(row.account_id) });
      } catch (e: any) {
        const msg = `Scheduled mail not sent: ${e?.response || e?.message || e}`;
        await queryDB("UPDATE mail_messages SET labels_json = ?, send_error = ?, scheduled_at = NULL WHERE id = ?", [JSON.stringify(["Drafts"]), msg.slice(0, 500), Number(row.id)]).catch(() => undefined);
        io.to(`user:${Number(row.user_id)}`).emit("mail:send-failed", { id: String(row.id), subject: row.subject, error: msg });
        void createAlert(queryDB, {
          userId: Number(row.user_id),
          type: "mail",
          title: "Scheduled mail not sent",
          message: `${row.subject || "(no subject)"} — kept in Drafts. ${msg}`.slice(0, 900),
          relatedType: "mail_message",
          relatedId: Number(row.id)
        });
      }
    }
  }

  if (runsBackgroundJobs()) {
    setTimeout(() => {
      void tickWatchers();
      setInterval(() => void tickWatchers(), 60_000);
    }, 20_000);
    setTimeout(() => {
      void sendScheduled();
      setInterval(() => void sendScheduled(), 60_000);
    }, 25_000);
    // Shared attachments of internal mail that no mail points at any more.
    const sweepBlobs = () =>
      void queryDB(
        "DELETE b FROM mail_blobs b LEFT JOIN mail_files f ON f.blob_id = b.id WHERE f.id IS NULL AND b.created_at < UTC_TIMESTAMP() - INTERVAL 1 DAY"
      ).catch(() => undefined);
    setTimeout(() => {
      sweepBlobs();
      setInterval(sweepBlobs, 6 * 60 * 60_000);
    }, 10 * 60_000);
  }
}
