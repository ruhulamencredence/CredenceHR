/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Notices (Admin Panel -> Notices, plus the popup / Notice Board people see).
//
// A notice has:
//   - content: formatted text (the composer's editor), pictures and
//     attachments (files in a folder, noticeFiles.ts), a cover picture,
//     optionally a Lottie animation;
//   - an audience: everyone, specific people, or groups (departments and / or
//     branches) — with people added or left out on top;
//   - a priority: normal (Notice Board and Dashboard only), important (also a
//     popup after login) or urgent (a popup that stays until "I have read
//     this" is tapped);
//   - a schedule: publish at / take down after (Dhaka time), pinned on top;
//   - delivery: push (default on), email (its own layer, notice_email),
//     a reminder next day to whoever hasn't read it.
// Who opened / acknowledged it is kept in notice_reads; the per-person report
// and "send again" are behind the notice_read_report layer.

import express, { type Express } from "express";
import fs from "fs";
import { sanitizeNoticeHtml, safeLottieJson, safeLottieUrl } from "./NoticeSafety";
import {
  NOTICE_FILE_MAX_BYTES,
  NOTICE_IMAGE_MAX_BYTES,
  looksLikeImage,
  noticeFileExtension,
  removeNoticeFile,
  resolveNoticePath,
  saveNoticeFile,
  type NoticeFileKind
} from "./noticeFiles";
import { sendMail } from "./mailer";
import { sendPushToUserIds } from "./PushNotificationService";

type Query = (sql: string, params?: any[]) => Promise<any>;

export interface RegisterNoticeRoutesDeps {
  announceNotice: (noticeId: number, title: string, audience: number[] | "all", senderId: number, opts?: { push?: boolean }) => Promise<void>;
  authenticateToken: any;
  queryDB: Query;
  requireAdmin: any;
  requireModule: any;
  requireModuleLayer: any;
  hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
  getAdminModules: (userId: number) => Promise<string[]>;
  runJobs: boolean;
}

// Schema for the notice features added after the first version — every step
// is safe to run again.
export async function ensureNoticeV2Schema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  const run = (sql: string, ignore: string[] = ["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]) =>
    dbPool.query(sql).catch((err: any) => {
      if (!ignore.includes(err?.code)) console.warn("⚠️ Notices: " + err.message);
    });
  await run("ALTER TABLE notices MODIFY COLUMN target_type ENUM('all','specific','groups') NOT NULL DEFAULT 'all'");
  for (const col of [
    // Notices made before priorities existed popped up after login: 'important'.
    "priority VARCHAR(10) NOT NULL DEFAULT 'important'",
    "publish_at DATETIME NULL",
    "expire_at DATETIME NULL",
    "pinned TINYINT(1) NOT NULL DEFAULT 0",
    "require_ack TINYINT(1) NOT NULL DEFAULT 0",
    "send_push TINYINT(1) NOT NULL DEFAULT 1",
    "send_email TINYINT(1) NOT NULL DEFAULT 0",
    "remind_unread TINYINT(1) NOT NULL DEFAULT 0",
    // People who join after it went out also get it (1), or only those who
    // were here then (0, the default — also for every notice made before).
    "new_joiners TINYINT(1) NOT NULL DEFAULT 0",
    "audience_json TEXT NULL",
    "cover_file_id INT NULL",
    // When it went out (push / email). Notices already out count as sent.
    "announced_at DATETIME NULL",
    "reminded_at DATETIME NULL"
  ]) {
    await run(`ALTER TABLE notices ADD COLUMN ${col}`);
  }
  await run("UPDATE notices SET announced_at = created_at WHERE announced_at IS NULL AND is_active = 1 AND publish_at IS NULL AND created_at < NOW() - INTERVAL 2 MINUTE");
  await run(`CREATE TABLE IF NOT EXISTS notice_files (
    id INT AUTO_INCREMENT PRIMARY KEY,
    notice_id INT NULL,
    kind ENUM('image','file') NOT NULL,
    role ENUM('inline','cover','attachment') NOT NULL DEFAULT 'attachment',
    original_name VARCHAR(255) NOT NULL,
    mimetype VARCHAR(150) NOT NULL,
    size_bytes INT NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    uploaded_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_notice_files_notice (notice_id),
    CONSTRAINT fk_notice_files_notice FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE,
    CONSTRAINT fk_notice_files_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
  )`);
  // Animation library: Lottie animations imported once (Notices -> New
  // notice -> Animation) and picked for any notice later; a notice keeps its
  // own copy, so removing one from the library never changes a notice.
  await run(`CREATE TABLE IF NOT EXISTS notice_animations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    lottie_json MEDIUMTEXT NOT NULL,
    size_bytes INT NOT NULL DEFAULT 0,
    created_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_notice_animations_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS notice_reads (
    id INT AUTO_INCREMENT PRIMARY KEY,
    notice_id INT NOT NULL,
    user_id INT NOT NULL,
    opened_at TIMESTAMP NULL DEFAULT NULL,
    acknowledged_at TIMESTAMP NULL DEFAULT NULL,
    UNIQUE KEY uq_notice_read (notice_id, user_id),
    CONSTRAINT fk_notice_reads_notice FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE,
    CONSTRAINT fk_notice_reads_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
}

// ---------------------------------------------------------------- helpers

interface AudienceSpec {
  departments: number[];
  branches: number[];
  include: number[];
  exclude: number[];
}
const ids = (v: any): number[] => (Array.isArray(v) ? Array.from(new Set(v.map(Number).filter((n: number) => Number.isFinite(n) && n > 0))) : []);
const parseAudience = (v: any): AudienceSpec => {
  let o: any = v;
  if (typeof v === "string") {
    try {
      o = JSON.parse(v);
    } catch {
      o = {};
    }
  }
  o = o || {};
  return { departments: ids(o.departments), branches: ids(o.branches), include: ids(o.include), exclude: ids(o.exclude) };
};

// Dhaka wall time "YYYY-MM-DD HH:MM" — publish_at / expire_at are entered in it.
const dhakaNow = () => new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
const toDbDateTime = (v: any): string | null => {
  const s = String(v ?? "").trim().replace("T", " ");
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? `${s.slice(0, 16)}:00` : null;
};
const short = (v: any) => (v ? String(v).slice(0, 16) : null);

const isLive = (n: any, now = dhakaNow()) =>
  !!Number(n.is_active) && (!n.publish_at || short(n.publish_at)! <= now) && (!n.expire_at || short(n.expire_at)! > now);

const statusOf = (n: any, now = dhakaNow()) =>
  !Number(n.is_active)
    ? n.source === "budget_import"
      ? "draft"
      : "paused"
    : n.expire_at && short(n.expire_at)! <= now
      ? "expired"
      : n.publish_at && short(n.publish_at)! > now
        ? "scheduled"
        : "live";

interface AudienceCtx {
  users: any[];
  // user id -> when they joined (account made, or joining date if later), ms.
  joinedAt: Map<number, number>;
  empByUser: Map<number, any>;
  targetsByNotice: Map<number, Set<number>>;
}
async function loadAudienceCtx(queryDB: Query): Promise<AudienceCtx> {
  const [users, emps, targets] = await Promise.all([
    queryDB("SELECT id, name, email, role, is_blocked, is_onboarding, created_at FROM users"),
    queryDB(
      "SELECT e.user_id, e.employee_id, e.designation, e.department_id, e.branch_id, e.joining_date, COALESCE(d.name, e.department) AS department_name FROM all_employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.user_id IS NOT NULL"
    ),
    queryDB("SELECT notice_id, user_id FROM notice_targets")
  ]);
  const empByUser = new Map<number, any>();
  for (const e of emps || []) if (!empByUser.has(Number(e.user_id))) empByUser.set(Number(e.user_id), e);
  const targetsByNotice = new Map<number, Set<number>>();
  for (const t of targets || []) {
    const k = Number(t.notice_id);
    if (!targetsByNotice.has(k)) targetsByNotice.set(k, new Set());
    targetsByNotice.get(k)!.add(Number(t.user_id));
  }
  const joinedAt = new Map<number, number>();
  for (const u of users || []) {
    const t = Math.max(msOf(u.created_at) ?? 0, msOf(empByUser.get(Number(u.id))?.joining_date) ?? 0);
    if (t > 0) joinedAt.set(Number(u.id), t);
  }
  return { users: (users || []).filter((u: any) => !Number(u.is_blocked) && !Number(u.is_onboarding)), joinedAt, empByUser, targetsByNotice };
}

const msOf = (v: any): number | null => {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v).replace(" ", "T"));
  return Number.isFinite(t) ? t : null;
};

// Everyone a notice goes to (its author left out). Unless the notice is set
// for new joiners too, someone who joined after it went out doesn't get it
// (people picked by name always do).
function recipientsOf(n: any, ctx: AudienceCtx): number[] {
  const a = parseAudience(n.audience_json);
  const ex = new Set(a.exclude);
  const out = new Set<number>();
  if (n.target_type === "all") for (const u of ctx.users) out.add(Number(u.id));
  else if (n.target_type === "specific") for (const id of ctx.targetsByNotice.get(Number(n.id)) || []) out.add(id);
  else {
    const deps = new Set(a.departments);
    const brs = new Set(a.branches);
    for (const u of ctx.users) {
      const e = ctx.empByUser.get(Number(u.id));
      if (e && ((e.department_id && deps.has(Number(e.department_id))) || (e.branch_id && brs.has(Number(e.branch_id))))) out.add(Number(u.id));
    }
    for (const id of a.include) out.add(id);
  }
  const active = new Set(ctx.users.map((u: any) => Number(u.id)));
  const wentOut = Number(n.new_joiners) || n.target_type === "specific" ? null : msOf(n.announced_at);
  const named = new Set(a.include);
  // A day's grace: a joining date has no time, and the clocks can differ.
  const tooNew = (id: number) => wentOut != null && !named.has(id) && (ctx.joinedAt.get(id) ?? 0) > wentOut + 86400000;
  return [...out].filter((id) => active.has(id) && !ex.has(id) && id !== Number(n.created_by) && !tooNew(id));
}

const fileUrl = (id: number) => `/api/notices/files/${id}`;
const fileOut = (f: any) => ({ id: Number(f.id), kind: f.kind, role: f.role, name: f.original_name, mimetype: f.mimetype, size: Number(f.size_bytes), url: fileUrl(Number(f.id)) });

// Picture ids written into the content (<img src="/api/notices/files/12">).
const inlineFileIds = (html: string) => Array.from(new Set(Array.from(String(html || "").matchAll(/\/api\/notices\/files\/(\d+)/g)).map((m) => Number(m[1]))));

export function registerNoticeRoutes(app: Express, deps: RegisterNoticeRoutesDeps) {
  const { announceNotice, authenticateToken, queryDB, requireAdmin, requireModule, requireModuleLayer, hasModuleLayer, getAdminModules, runJobs } = deps;

  const parseJsonBody = <T,>(value: any): T | null => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "object") return value as T;
    try {
      return JSON.parse(String(value));
    } catch {
      return null;
    }
  };

  const managesNotices = async (user: any) => {
    if (!user || user.onb) return false;
    if (user.role === "superadmin") return true;
    if (user.role !== "admin" && user.role !== "user") return false;
    return (await getAdminModules(user.id)).includes("notices");
  };

  const filesByNotice = async (noticeIds: number[]) => {
    const map = new Map<number, any[]>();
    if (!noticeIds.length) return map;
    const rows: any[] = (await queryDB(`SELECT * FROM notice_files WHERE notice_id IN (${noticeIds.map(() => "?").join(",")}) ORDER BY id`, noticeIds)) || [];
    for (const f of rows) {
      const k = Number(f.notice_id);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(f);
    }
    return map;
  };

  // A notice as people see it (popup, board).
  const noticeOut = (n: any, files: any[], read?: any, from?: string | null) => ({
    id: n.id,
    title: n.title,
    content_html: sanitizeNoticeHtml(n.content_html),
    lottie_json: n.lottie_json ? safeLottieJson(n.lottie_json) : null,
    lottie_url: safeLottieUrl(n.lottie_url),
    source: n.source || null,
    priority: n.priority || "important",
    require_ack: !!Number(n.require_ack),
    pinned: !!Number(n.pinned),
    publish_at: short(n.publish_at),
    cover: files.filter((f) => f.role === "cover").map(fileOut)[0] || null,
    attachments: files.filter((f) => f.role === "attachment").map(fileOut),
    created_at: n.publish_at || n.created_at,
    opened_at: read?.opened_at || null,
    acknowledged_at: read?.acknowledged_at || null,
    // Who posted it (shown as "From …" on the board / popup).
    from_name: from || null
  });
  // id -> name of the people who posted these notices.
  const posterNames = async (list: any[]): Promise<Map<number, string>> => {
    const ids = Array.from(new Set(list.map((n) => Number(n.created_by)).filter((x) => x > 0)));
    if (!ids.length) return new Map();
    const rows: any[] = (await queryDB(`SELECT id, name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`, ids).catch(() => [])) || [];
    return new Map(rows.map((r: any) => [Number(r.id), String(r.name || "")]));
  };

  const NOTICE_SELECT = "SELECT * FROM notices";

  // Push / live update / email for a notice that is live now (once).
  const announce = async (n: any, senderId: number) => {
    try {
      const ctx = await loadAudienceCtx(queryDB);
      const to = recipientsOf(n, ctx);
      await queryDB("UPDATE notices SET announced_at = NOW() WHERE id = ?", [n.id]);
      void announceNotice(Number(n.id), n.title, n.target_type === "all" && !parseAudience(n.audience_json).exclude.length ? "all" : to, senderId, { push: !!Number(n.send_push) });
      if (Number(n.send_email)) void emailNotice(n, to, ctx);
    } catch (err: any) {
      console.warn("⚠️ Notice announce: " + err.message);
    }
  };

  const emailNotice = async (n: any, to: number[], ctx: AudienceCtx) => {
    const base = String(process.env.PUBLIC_APP_URL || "").replace(/\/+$/, "");
    // Pictures in the notice are behind the login; the email says where to see them.
    const body = sanitizeNoticeHtml(n.content_html).replace(/<img[^>]*>/gi, "<p><i>[picture — open CredenceHR to see it]</i></p>");
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a"><h2 style="margin:0 0 12px">${String(n.title)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")}</h2>${body}<p style="color:#64748b;font-size:12px;margin-top:18px">Notice from CredenceHR${base ? ` — <a href="${base}">${base}</a>` : ""}.</p></div>`;
    const byId = new Map(ctx.users.map((u: any) => [Number(u.id), u]));
    for (const id of to) {
      const email = String(byId.get(id)?.email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      const r = await sendMail({ to: email, subject: String(n.title).replace(/[\r\n]+/g, " ").slice(0, 200), html });
      if (!r.success) {
        console.warn("⚠️ Notice email: " + r.error);
        break;
      }
    }
  };

  // ------------------------------------------------------------ admin side

  // Who a notice can go to: departments, branches and people (with what they
  // are known by: Employee ID, designation, department).
  app.get("/api/notices/audience-options", authenticateToken, requireAdmin, requireModule("notices"), async (_req, res) => {
    try {
      const [departments, branches, ctx] = await Promise.all([
        queryDB("SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name"),
        queryDB("SELECT id, branch_name AS name FROM branches ORDER BY branch_name"),
        loadAudienceCtx(queryDB)
      ]);
      res.json({
        departments: departments || [],
        branches: branches || [],
        people: ctx.users
          .map((u: any) => {
            const e = ctx.empByUser.get(Number(u.id));
            return {
              id: Number(u.id),
              name: u.name,
              role: u.role,
              employee_code: e?.employee_id || null,
              designation: e?.designation || null,
              department: e?.department_name || null,
              department_id: e?.department_id ? Number(e.department_id) : null,
              branch_id: e?.branch_id ? Number(e.branch_id) : null
            };
          })
          .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Kept for older screens: plain User accounts only.
  // ---- Animation library ------------------------------------------------
  const ANIMATION_MAX_BYTES = 3 * 1024 * 1024;
  app.get("/api/notices/animations", authenticateToken, requireAdmin, requireModule("notices"), async (req: any, res) => {
    try {
      const rows: any[] =
        (await queryDB("SELECT a.id, a.name, a.size_bytes, a.created_at, u.name AS by_name FROM notice_animations a LEFT JOIN users u ON u.id = a.created_by ORDER BY a.name ASC")) || [];
      res.json({
        can_manage: await hasModuleLayer(req.user, "notices", "notice_animations"),
        items: rows.map((r) => ({ id: Number(r.id), name: r.name, size: Number(r.size_bytes) || 0, by: r.by_name || null, at: r.created_at }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get("/api/notices/animations/:id(\\d+)", authenticateToken, requireAdmin, requireModule("notices"), async (req: any, res) => {
    try {
      const r: any = ((await queryDB("SELECT id, name, lottie_json FROM notice_animations WHERE id = ?", [Number(req.params.id)])) || [])[0];
      if (!r) return res.status(404).json({ error: "Animation not found." });
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.json({ id: Number(r.id), name: r.name, lottie_json: safeLottieJson(r.lottie_json) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/notices/animations", authenticateToken, requireAdmin, requireModule("notices"), requireModuleLayer("notices", "notice_animations"), async (req: any, res) => {
    try {
      const name = String(req.body?.name || "").replace(/[\r\n]/g, " ").trim().slice(0, 120);
      if (!name) return res.status(400).json({ error: "Give the animation a name." });
      const raw = req.body?.lottie_json;
      const text = typeof raw === "string" ? raw : raw ? JSON.stringify(raw) : "";
      if (!text) return res.status(400).json({ error: "Pick a Lottie .json file." });
      if (Buffer.byteLength(text) > ANIMATION_MAX_BYTES) return res.status(413).json({ error: "An animation can be up to 3 MB." });
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        return res.status(400).json({ error: "That file isn't valid JSON." });
      }
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.layers) || !(Number(parsed.w) > 0) || !(Number(parsed.h) > 0)) {
        return res.status(400).json({ error: "That isn't a Lottie animation (export it from LottieFiles / After Effects as .json)." });
      }
      // Expressions (JavaScript inside the file) are taken out (NoticeSafety.ts).
      const safe = safeLottieJson(parsed);
      if (!safe) return res.status(400).json({ error: "That animation couldn't be read." });
      const r: any = await queryDB("INSERT INTO notice_animations (name, lottie_json, size_bytes, created_by) VALUES (?, ?, ?, ?)", [name, safe, Buffer.byteLength(safe), req.user.id]);
      res.status(201).json({ id: Number(r.insertId), name, size: Buffer.byteLength(safe) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.delete("/api/notices/animations/:id(\\d+)", authenticateToken, requireAdmin, requireModule("notices"), requireModuleLayer("notices", "notice_animations"), async (req: any, res) => {
    try {
      const r: any = await queryDB("DELETE FROM notice_animations WHERE id = ?", [Number(req.params.id)]);
      if (!r?.affectedRows) return res.status(404).json({ error: "Animation not found." });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/notices/recipients", authenticateToken, requireAdmin, requireModule("notices"), async (_req, res) => {
    try {
      const rows = await queryDB("SELECT * FROM users");
      // Everyone a notice can be for: Users, Admins, and a Superadmin who is
      // also an employee (has an Employee record). Was plain Users only.
      const empUserIds = new Set<number>(((await queryDB("SELECT user_id FROM all_employees WHERE user_id IS NOT NULL").catch(() => [])) || []).map((e: any) => Number(e.user_id)));
      res.json(
        rows
          .filter((u: any) => u.role === "user" || u.role === "admin" || (u.role === "superadmin" && empUserIds.has(Number(u.id))))
          .map((u: any) => ({ id: u.id, name: u.name, email: u.email || null, username: u.username || null }))
          .sort((a: any, b: any) => a.name.localeCompare(b.name))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // A picture or attachment for a notice being written. The file itself is
  // the body; ?kind=image|file&name=…&type=… say what it is. It belongs to no
  // notice until one is saved with it (unused uploads go after two days).
  const rawUpload = express.raw({ type: () => true, limit: NOTICE_FILE_MAX_BYTES });
  app.post("/api/notices/files", authenticateToken, requireAdmin, requireModule("notices"), rawUpload, async (req: any, res) => {
    try {
      const kind: NoticeFileKind = req.query.kind === "image" ? "image" : "file";
      const mimetype = String(req.query.type || req.headers["content-type"] || "").toLowerCase().split(";")[0].trim();
      const name = String(req.query.name || (kind === "image" ? "picture" : "file")).replace(/[\r\n"\\/]/g, " ").trim().slice(0, 200) || "file";
      const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!buf.length) return res.status(400).json({ error: "The file is empty." });
      const ext = noticeFileExtension(kind, mimetype);
      if (!ext) {
        return res.status(400).json({
          error: kind === "image" ? "Pictures can be PNG, JPG, WebP or GIF." : "Attachments can be PDF, Word, Excel, PowerPoint, text, CSV or a picture."
        });
      }
      if (kind === "image" && buf.length > NOTICE_IMAGE_MAX_BYTES) return res.status(413).json({ error: "A picture can be up to 5 MB." });
      if (mimetype.startsWith("image/") && !looksLikeImage(buf, mimetype)) return res.status(400).json({ error: "That file is not really a picture of that type." });
      const stored = await saveNoticeFile(buf, kind, ext);
      const r: any = await queryDB(
        "INSERT INTO notice_files (notice_id, kind, role, original_name, mimetype, size_bytes, file_path, uploaded_by) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)",
        [kind, kind === "image" ? "inline" : "attachment", name, mimetype, buf.length, stored, req.user.id]
      );
      res.status(201).json({ id: r.insertId, kind, name, mimetype, size: buf.length, url: fileUrl(r.insertId) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // A notice's picture / attachment: for the Notices people, and for anyone
  // the notice is live for.
  app.get("/api/notices/files/:id(\\d+)", authenticateToken, async (req: any, res) => {
    try {
      const f: any = ((await queryDB("SELECT * FROM notice_files WHERE id = ?", [Number(req.params.id)])) || [])[0];
      if (!f) return res.status(404).json({ error: "File not found." });
      let allowed = await managesNotices(req.user);
      if (!allowed && f.notice_id) {
        const n: any = ((await queryDB(NOTICE_SELECT + " WHERE id = ?", [f.notice_id])) || [])[0];
        if (n && isLive(n)) {
          const ctx = await loadAudienceCtx(queryDB);
          allowed = recipientsOf(n, ctx).includes(Number(req.user.id)) || Number(n.created_by) === Number(req.user.id);
        }
      }
      if (!allowed) return res.status(403).json({ error: "You can't open this file." });
      const full = resolveNoticePath(f.file_path);
      if (!full || !fs.existsSync(full)) return res.status(404).json({ error: "The file is missing on the server." });
      const inline = f.kind === "image" || f.mimetype === "application/pdf";
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Type", f.mimetype || "application/octet-stream");
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
      res.sendFile(full, { dotfiles: "deny", cacheControl: false, lastModified: false });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Every notice, newest first, with its audience size, how many opened /
  // acknowledged it, and its state (live, scheduled, expired, paused).
  app.get("/api/notices", authenticateToken, requireAdmin, requireModule("notices"), async (_req, res) => {
    try {
      const notices: any[] = (await queryDB(NOTICE_SELECT)) || [];
      const [ctx, dismissals, reads, files] = await Promise.all([
        loadAudienceCtx(queryDB),
        queryDB("SELECT notice_id, user_id FROM notice_dismissals"),
        queryDB("SELECT notice_id, user_id, opened_at, acknowledged_at FROM notice_reads"),
        filesByNotice(notices.map((n) => Number(n.id)))
      ]);
      const users: any[] = (await queryDB("SELECT id, name FROM users")) || [];
      const nameOf = new Map<number, string>(users.map((u: any) => [Number(u.id), u.name]));
      const now = dhakaNow();
      const sorted = [...notices].sort((a: any, b: any) => Number(b.id) - Number(a.id));
      res.json(
        sorted.map((n: any) => {
          const audience = new Set(recipientsOf(n, ctx));
          const opened = new Set<number>();
          const acked = new Set<number>();
          for (const d of dismissals || []) if (Number(d.notice_id) === Number(n.id) && audience.has(Number(d.user_id))) opened.add(Number(d.user_id));
          for (const r of reads || []) {
            if (Number(r.notice_id) !== Number(n.id) || !audience.has(Number(r.user_id))) continue;
            if (r.opened_at || r.acknowledged_at) opened.add(Number(r.user_id));
            if (r.acknowledged_at) acked.add(Number(r.user_id));
          }
          const targetUserIds = [...(ctx.targetsByNotice.get(Number(n.id)) || [])];
          const nf = files.get(Number(n.id)) || [];
          return {
            id: n.id,
            title: n.title,
            content_html: sanitizeNoticeHtml(n.content_html),
            lottie_json: n.lottie_json ? safeLottieJson(n.lottie_json) : null,
            lottie_url: safeLottieUrl(n.lottie_url),
            target_type: n.target_type,
            audience: parseAudience(n.audience_json),
            source: n.source || null,
            is_active: !!Number(n.is_active),
            status: statusOf(n, now),
            priority: n.priority || "important",
            publish_at: short(n.publish_at),
            expire_at: short(n.expire_at),
            pinned: !!Number(n.pinned),
            require_ack: !!Number(n.require_ack),
            send_push: !!Number(n.send_push),
            send_email: !!Number(n.send_email),
            remind_unread: !!Number(n.remind_unread),
            new_joiners: !!Number(n.new_joiners),
            cover: nf.filter((f) => f.role === "cover").map(fileOut)[0] || null,
            files: nf.map(fileOut),
            created_by: n.created_by,
            created_by_name: nameOf.get(Number(n.created_by)) || null,
            created_at: n.created_at,
            updated_at: n.updated_at,
            target_user_ids: targetUserIds,
            target_users: targetUserIds.map((id: number) => ({ id, name: nameOf.get(id) || "Unknown" })),
            audience_count: audience.size,
            seen_count: opened.size,
            ack_count: acked.size,
            seen_by: Array.from(opened).map((id) => nameOf.get(id) || "Unknown").sort()
          };
        })
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Reads and checks the composer's fields; null + sends the error otherwise.
  const readNoticeBody = async (req: any, res: any) => {
    const b = req.body || {};
    const title = String(b.title || "").trim();
    if (!title) return void res.status(400).json({ error: "Title is required" });
    if (!b.content_html || !String(b.content_html).trim()) return void res.status(400).json({ error: "Notice content is required" });
    let lottieJsonStr: string | null = null;
    if (b.lottie_json && String(b.lottie_json).trim()) {
      const parsed = parseJsonBody(b.lottie_json);
      if (!parsed) return void res.status(400).json({ error: "The pasted Lottie animation isn't valid JSON." });
      lottieJsonStr = safeLottieJson(parsed);
    }
    if (b.lottie_url && String(b.lottie_url).trim() && !safeLottieUrl(b.lottie_url)) {
      return void res.status(400).json({ error: "The Lottie animation link must be an http(s) address." });
    }
    // Only plain formatting is kept (NoticeSafety.ts).
    const safeHtml = sanitizeNoticeHtml(b.content_html);
    if (!safeHtml.replace(/<[^>]*>/g, "").trim() && !/<img/i.test(safeHtml)) return void res.status(400).json({ error: "Notice content is required" });
    const target_type = b.target_type === "specific" ? "specific" : b.target_type === "groups" ? "groups" : "all";
    const audience = parseAudience(b.audience);
    if (target_type === "groups" && !audience.departments.length && !audience.branches.length && !audience.include.length) {
      return void res.status(400).json({ error: "Pick at least one department, branch or person." });
    }
    const userIds = ids(b.target_user_ids);
    if (target_type === "specific" && !userIds.length) return void res.status(400).json({ error: "Pick at least one person." });
    const priority = ["normal", "important", "urgent"].includes(b.priority) ? b.priority : "important";
    const publish_at = toDbDateTime(b.publish_at);
    const expire_at = toDbDateTime(b.expire_at);
    if (publish_at && expire_at && expire_at <= publish_at) return void res.status(400).json({ error: "Take-down time must be after the publish time." });
    if (expire_at && expire_at.slice(0, 16) <= dhakaNow() && b.is_active !== false) return void res.status(400).json({ error: "The take-down time has already passed." });
    const send_email = !!b.send_email;
    if (send_email && !(await hasModuleLayer(req.user, "notices", "notice_email"))) {
      return void res.status(403).json({ error: "You don't have permission to send notices by email. Ask your Superadmin to grant it." });
    }
    return {
      title: title.slice(0, 200),
      safeHtml,
      lottieJsonStr,
      lottieUrlStr: safeLottieUrl(b.lottie_url),
      target_type,
      audience,
      userIds,
      priority,
      publish_at,
      expire_at,
      pinned: b.pinned ? 1 : 0,
      // Urgent always asks for "I have read this".
      require_ack: b.require_ack || priority === "urgent" ? 1 : 0,
      send_push: b.send_push === false ? 0 : 1,
      send_email: send_email ? 1 : 0,
      remind_unread: b.remind_unread ? 1 : 0,
      new_joiners: b.new_joiners ? 1 : 0,
      cover_file_id: Number(b.cover_file_id) || null,
      attachment_ids: ids(b.attachment_ids)
    };
  };

  // Ties the uploaded pictures / attachments to the notice; files it no longer
  // uses are deleted.
  const linkFiles = async (noticeId: number, v: any) => {
    const inline = inlineFileIds(v.safeHtml);
    const wanted = new Map<number, string>();
    for (const id of inline) wanted.set(id, "inline");
    for (const id of v.attachment_ids) wanted.set(id, "attachment");
    if (v.cover_file_id) wanted.set(v.cover_file_id, "cover");
    for (const [id, role] of wanted) {
      await queryDB("UPDATE notice_files SET notice_id = ?, role = ? WHERE id = ? AND (notice_id IS NULL OR notice_id = ?)", [noticeId, role, id, noticeId]);
    }
    const rows: any[] = (await queryDB("SELECT id, file_path FROM notice_files WHERE notice_id = ?", [noticeId])) || [];
    for (const r of rows) {
      if (wanted.has(Number(r.id))) continue;
      await queryDB("DELETE FROM notice_files WHERE id = ?", [r.id]);
      await removeNoticeFile(r.file_path);
    }
    const cover = v.cover_file_id && rows.some((r) => Number(r.id) === v.cover_file_id) ? v.cover_file_id : null;
    await queryDB("UPDATE notices SET cover_file_id = ? WHERE id = ?", [cover, noticeId]);
  };

  const saveTargets = async (noticeId: number, v: any) => {
    await queryDB("DELETE FROM notice_targets WHERE notice_id = ?", [noticeId]);
    if (v.target_type === "specific") for (const uid of v.userIds) await queryDB("INSERT INTO notice_targets (notice_id, user_id) VALUES (?, ?)", [noticeId, uid]);
  };

  app.post("/api/notices", authenticateToken, requireAdmin, requireModule("notices"), async (req: any, res) => {
    try {
      const v = await readNoticeBody(req, res);
      if (!v) return;
      const isActive = req.body.is_active === false ? 0 : 1;
      const result = await queryDB(
        `INSERT INTO notices (title, content_html, lottie_json, lottie_url, target_type, is_active, created_by, priority, publish_at, expire_at,
                              pinned, require_ack, send_push, send_email, remind_unread, new_joiners, audience_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [v.title, v.safeHtml, v.lottieJsonStr, v.lottieUrlStr, v.target_type, isActive, req.user.id, v.priority, v.publish_at, v.expire_at,
          v.pinned, v.require_ack, v.send_push, v.send_email, v.remind_unread, v.new_joiners, JSON.stringify(v.audience)]
      );
      const noticeId = result.insertId;
      await saveTargets(noticeId, v);
      await linkFiles(noticeId, v);
      const n: any = ((await queryDB(NOTICE_SELECT + " WHERE id = ?", [noticeId])) || [])[0];
      // Out now if it is live; a scheduled one goes out at its time (noticeJobs).
      if (n && isLive(n)) await announce(n, req.user.id);
      res.status(201).json({ id: noticeId, status: n ? statusOf(n) : "live" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/notices/:id", authenticateToken, requireAdmin, requireModule("notices"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const existing: any[] = await queryDB("SELECT * FROM notices WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Notice not found" });
      const v = await readNoticeBody(req, res);
      if (!v) return;
      // An email ticked by someone else stays as it was for an editor without the right.
      await queryDB(
        `UPDATE notices SET title = ?, content_html = ?, lottie_json = ?, lottie_url = ?, target_type = ?, priority = ?, publish_at = ?, expire_at = ?,
                pinned = ?, require_ack = ?, send_push = ?, send_email = ?, remind_unread = ?, new_joiners = ?, audience_json = ? WHERE id = ?`,
        [v.title, v.safeHtml, v.lottieJsonStr, v.lottieUrlStr, v.target_type, v.priority, v.publish_at, v.expire_at,
          v.pinned, v.require_ack, v.send_push, v.send_email, v.remind_unread, v.new_joiners, JSON.stringify(v.audience), id]
      );
      // Edited by a person: a later Budget import writes a new draft instead
      // of overwriting these edits (BudgetNoticeDraft.ts).
      await queryDB("UPDATE notices SET source_ref = NULL WHERE id = ? AND source = 'budget_import'", [id]).catch(() => {});
      // Moved to a later publish time and not out yet: it goes out then.
      if (v.publish_at && v.publish_at.slice(0, 16) > dhakaNow()) await queryDB("UPDATE notices SET announced_at = NULL WHERE id = ?", [id]);
      await saveTargets(id, v);
      await linkFiles(id, v);
      const n: any = ((await queryDB(NOTICE_SELECT + " WHERE id = ?", [id])) || [])[0];
      if (n && isLive(n) && !n.announced_at) await announce(n, req.user.id);
      res.json({ success: true, status: n ? statusOf(n) : "live" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Publish / pause — pulls a notice down (or brings it back) without losing
  // it or who has read it.
  app.put("/api/notices/:id/active", authenticateToken, requireAdmin, requireModule("notices"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM notices WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Notice not found" });
      await queryDB("UPDATE notices SET is_active = ? WHERE id = ?", [req.body.is_active ? 1 : 0, id]);
      if (req.body.is_active) await queryDB("UPDATE notices SET source_ref = NULL WHERE id = ? AND source = 'budget_import'", [id]).catch(() => {});
      // Published again: show it live and push it, like a new one.
      if (req.body.is_active && !Number(existing[0].is_active)) {
        const n: any = ((await queryDB(NOTICE_SELECT + " WHERE id = ?", [id])) || [])[0];
        if (n && isLive(n)) await announce(n, req.user.id);
        else await queryDB("UPDATE notices SET announced_at = NULL WHERE id = ?", [id]);
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/notices/:id", authenticateToken, requireAdmin, requireModule("notices"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM notices WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Notice not found" });
      const files: any[] = (await queryDB("SELECT file_path FROM notice_files WHERE notice_id = ?", [id])) || [];
      await queryDB("DELETE FROM notices WHERE id = ?", [id]);
      for (const f of files) await removeNoticeFile(f.file_path);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Who it went to and who has opened / acknowledged it (notice_read_report).
  app.get("/api/notices/:id(\\d+)/report", authenticateToken, requireAdmin, requireModule("notices"), requireModuleLayer("notices", "notice_read_report"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const n: any = ((await queryDB(NOTICE_SELECT + " WHERE id = ?", [id])) || [])[0];
      if (!n) return res.status(404).json({ error: "Notice not found" });
      const ctx = await loadAudienceCtx(queryDB);
      const [reads, dismissals] = await Promise.all([
        queryDB("SELECT user_id, opened_at, acknowledged_at FROM notice_reads WHERE notice_id = ?", [id]),
        queryDB("SELECT user_id, dismissed_at FROM notice_dismissals WHERE notice_id = ?", [id])
      ]);
      const readBy = new Map<number, any>((reads || []).map((r: any) => [Number(r.user_id), r]));
      const dismissedBy = new Map<number, any>((dismissals || []).map((d: any) => [Number(d.user_id), d.dismissed_at]));
      const byId = new Map(ctx.users.map((u: any) => [Number(u.id), u]));
      const rows = recipientsOf(n, ctx)
        .map((uid) => {
          const u = byId.get(uid);
          const e = ctx.empByUser.get(uid);
          const r = readBy.get(uid);
          const opened = r?.opened_at || r?.acknowledged_at || dismissedBy.get(uid) || null;
          return {
            user_id: uid,
            name: u?.name || "Unknown",
            employee_code: e?.employee_id || null,
            designation: e?.designation || null,
            department: e?.department_name || null,
            opened_at: opened,
            acknowledged_at: r?.acknowledged_at || null,
            state: r?.acknowledged_at ? "acknowledged" : opened ? "opened" : "not_yet"
          };
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      res.json({
        notice: { id: n.id, title: n.title, require_ack: !!Number(n.require_ack), status: statusOf(n) },
        total: rows.length,
        acknowledged: rows.filter((r) => r.state === "acknowledged").length,
        opened: rows.filter((r) => r.state === "opened").length,
        not_yet: rows.filter((r) => r.state === "not_yet").length,
        rows
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // "Send again" to everyone who hasn't read it yet (push).
  const remindUnread = async (n: any, senderId?: number) => {
    const ctx = await loadAudienceCtx(queryDB);
    const reads: any[] = (await queryDB("SELECT user_id, opened_at, acknowledged_at FROM notice_reads WHERE notice_id = ?", [n.id])) || [];
    const dismissed: any[] = (await queryDB("SELECT user_id FROM notice_dismissals WHERE notice_id = ?", [n.id])) || [];
    const done = new Set<number>();
    for (const r of reads) if (Number(n.require_ack) ? r.acknowledged_at : r.opened_at || r.acknowledged_at) done.add(Number(r.user_id));
    if (!Number(n.require_ack)) for (const d of dismissed) done.add(Number(d.user_id));
    const to = recipientsOf(n, ctx).filter((id) => !done.has(id));
    if (to.length) {
      await sendPushToUserIds(queryDB, to, "Reminder: notice", String(n.title || "").slice(0, 120), { type: "notice", relatedType: "notice", relatedId: String(n.id) }, senderId);
    }
    return to.length;
  };
  app.post("/api/notices/:id(\\d+)/remind", authenticateToken, requireAdmin, requireModule("notices"), requireModuleLayer("notices", "notice_read_report"), async (req: any, res) => {
    try {
      const n: any = ((await queryDB(NOTICE_SELECT + " WHERE id = ?", [Number(req.params.id)])) || [])[0];
      if (!n) return res.status(404).json({ error: "Notice not found" });
      if (!isLive(n)) return res.status(400).json({ error: "This notice isn't live right now." });
      res.json({ success: true, sent: await remindUnread(n, req.user.id) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ------------------------------------------------------------ people side

  // Live, targeted notices that should pop up for this account now —
  // important / urgent ones not closed yet (an "I have read this" one stays
  // until it is acknowledged). Oldest first.
  app.get("/api/notices/active", authenticateToken, async (req: any, res) => {
    try {
      const me = Number(req.user.id);
      const now = dhakaNow();
      const notices: any[] = ((await queryDB(NOTICE_SELECT)) || []).filter((n: any) => isLive(n, now) && (n.priority || "important") !== "normal");
      if (notices.length === 0) return res.json([]);
      const [ctx, dismissals, reads] = await Promise.all([
        loadAudienceCtx(queryDB),
        queryDB("SELECT notice_id FROM notice_dismissals WHERE user_id = ?", [me]),
        queryDB("SELECT notice_id, opened_at, acknowledged_at FROM notice_reads WHERE user_id = ?", [me])
      ]);
      const dismissedIds = new Set((dismissals || []).map((d: any) => Number(d.notice_id)));
      const readOf = new Map<number, any>((reads || []).map((r: any) => [Number(r.notice_id), r]));
      const visible = notices.filter((n: any) => {
        if (Number(n.created_by) === me) return false;
        if (Number(n.require_ack) ? readOf.get(Number(n.id))?.acknowledged_at : dismissedIds.has(Number(n.id))) return false;
        return recipientsOf(n, ctx).includes(me);
      });
      visible.sort((a: any, b: any) => Number(a.id) - Number(b.id));
      const [files, posters] = await Promise.all([filesByNotice(visible.map((n) => Number(n.id))), posterNames(visible)]);
      res.json(visible.map((n: any) => noticeOut(n, files.get(Number(n.id)) || [], readOf.get(Number(n.id)), posters.get(Number(n.created_by)))));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Every notice live for this account (closing the popup doesn't remove it
  // from here) — pinned first, then newest.
  app.get("/api/notices/board", authenticateToken, async (req: any, res) => {
    try {
      const me = Number(req.user.id);
      const now = dhakaNow();
      const notices: any[] = ((await queryDB(NOTICE_SELECT)) || []).filter((n: any) => isLive(n, now));
      if (notices.length === 0) return res.json([]);
      const [ctx, reads] = await Promise.all([loadAudienceCtx(queryDB), queryDB("SELECT notice_id, opened_at, acknowledged_at FROM notice_reads WHERE user_id = ?", [me])]);
      const readOf = new Map<number, any>((reads || []).map((r: any) => [Number(r.notice_id), r]));
      const visible = notices.filter((n: any) => Number(n.created_by) === me || recipientsOf(n, ctx).includes(me));
      visible.sort((a: any, b: any) => Number(b.pinned || 0) - Number(a.pinned || 0) || Number(b.id) - Number(a.id));
      const [files, posters] = await Promise.all([filesByNotice(visible.map((n) => Number(n.id))), posterNames(visible)]);
      res.json(visible.map((n: any) => noticeOut(n, files.get(Number(n.id)) || [], readOf.get(Number(n.id)), posters.get(Number(n.created_by)))));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const forMe = async (req: any, res: any) => {
    const id = Number(req.params.id);
    const n: any = ((await queryDB(NOTICE_SELECT + " WHERE id = ?", [id])) || [])[0];
    if (!n) return void res.status(404).json({ error: "Notice not found." });
    if (!isLive(n) || !recipientsOf(n, await loadAudienceCtx(queryDB)).includes(Number(req.user.id))) return void res.status(403).json({ error: "This notice isn't for you." });
    return n;
  };

  // Opened (popup shown / read on the board).
  app.post("/api/notices/:id(\\d+)/seen", authenticateToken, async (req: any, res) => {
    try {
      const n = await forMe(req, res);
      if (!n) return;
      await queryDB(
        "INSERT INTO notice_reads (notice_id, user_id, opened_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE opened_at = COALESCE(opened_at, VALUES(opened_at))",
        [n.id, req.user.id]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // "I have read this".
  app.post("/api/notices/:id(\\d+)/ack", authenticateToken, async (req: any, res) => {
    try {
      const n = await forMe(req, res);
      if (!n) return;
      await queryDB(
        "INSERT INTO notice_reads (notice_id, user_id, opened_at, acknowledged_at) VALUES (?, ?, NOW(), NOW()) ON DUPLICATE KEY UPDATE opened_at = COALESCE(opened_at, NOW()), acknowledged_at = COALESCE(acknowledged_at, NOW())",
        [n.id, req.user.id]
      );
      await queryDB("INSERT IGNORE INTO notice_dismissals (notice_id, user_id) VALUES (?, ?)", [n.id, req.user.id]).catch(() => {});
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Closes the popup for good (a notice that asks "I have read this" is
  // acknowledged instead, /ack).
  app.post("/api/notices/:id/dismiss", authenticateToken, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const found: any[] = await queryDB("SELECT id FROM notices WHERE id = ?", [id]);
      if (!found.length) return res.status(404).json({ error: "Notice not found." });
      await queryDB("INSERT IGNORE INTO notice_dismissals (notice_id, user_id) VALUES (?, ?)", [id, req.user.id]);
      await queryDB(
        "INSERT INTO notice_reads (notice_id, user_id, opened_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE opened_at = COALESCE(opened_at, VALUES(opened_at))",
        [id, req.user.id]
      ).catch(() => {});
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ------------------------------------------------------------ background
  // Every minute (one process): a scheduled notice goes out at its time; the
  // next-day reminder for "remind whoever hasn't read it"; unused uploads go.
  if (runJobs) {
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const now = dhakaNow();
        const rows: any[] = (await queryDB("/*unscoped*/ SELECT * FROM notices WHERE is_active = 1 AND announced_at IS NULL")) || [];
        for (const n of rows) if (isLive(n, now)) await announce(n, Number(n.created_by) || 0);
        const due: any[] =
          (await queryDB("/*unscoped*/ SELECT * FROM notices WHERE is_active = 1 AND remind_unread = 1 AND reminded_at IS NULL AND announced_at IS NOT NULL AND announced_at <= NOW() - INTERVAL 1 DAY")) || [];
        for (const n of due) {
          await queryDB("/*unscoped*/ UPDATE notices SET reminded_at = NOW() WHERE id = ?", [n.id]);
          if (isLive(n, now)) await remindUnread(n);
        }
        const stale: any[] = (await queryDB("/*unscoped*/ SELECT id, file_path FROM notice_files WHERE notice_id IS NULL AND created_at < NOW() - INTERVAL 2 DAY LIMIT 50")) || [];
        for (const f of stale) {
          await queryDB("/*unscoped*/ DELETE FROM notice_files WHERE id = ?", [f.id]);
          await removeNoticeFile(f.file_path);
        }
      } catch (err: any) {
        console.warn("⚠️ Notice jobs: " + err.message);
      } finally {
        busy = false;
      }
    }, 60 * 1000);
  }
}
