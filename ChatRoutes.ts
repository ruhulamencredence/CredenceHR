/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Chat (Direct messages / Group chat / Community — WhatsApp-style) — split
// into its own file from day one, same reasoning as ConveyanceBillClaimRoutes.ts
// / AssetManagementRoutes.ts: server.ts is already huge, so this stays out as
// its own module, registered from inside startServer() via
// registerChatRoutes(), reusing that request's authenticateToken/queryDB
// rather than a second Express app or DB connection. The real-time half
// (Socket.IO) is wired separately via setupChatSocket() on the same
// http.Server instance server.ts already creates for Vite's HMR — see the
// call site there for why sharing one server/port matters on the APK.
//
// Data model:
//   chat_rooms         — one row per conversation. type='direct' is always
//                        exactly 2 members (see findOrCreateDirectRoom);
//                        'group' and 'community' can have any number.
//                        parent_room_id links a 'group' under a 'community'
//                        (WhatsApp Community's sub-groups) — null for a
//                        standalone group or a community itself.
//   chat_room_members  — membership + role ('admin' can add/remove members,
//                        promote/demote, and attach sub-groups; 'member'
//                        just participates). A room's creator is auto-added
//                        as 'admin'.
//   chat_messages      — text/image/file. Attachments use the same
//                        base64 -> LONGBLOB pattern as every other upload in
//                        this app (see profileRoutes.ts's /api/profile/photo)
//                        — no multipart/multer anywhere else, so this
//                        doesn't introduce a second upload mechanism.
//   chat_room_reads    — ONE row per (room, user) holding the highest
//                        message id that account has read, not one row per
//                        message per recipient (which would explode row
//                        count in a busy group). A message is "read" by
//                        someone once their row's last_read_message_id is
//                        >= that message's id — same double-tick UX as
//                        WhatsApp, much cheaper to store.
//
// Real-time vs REST split: text messages go over the socket 'send_message'
// event for lowest latency. Image/file messages always go through the REST
// POST (which already accepts up to 25mb JSON bodies — see server.ts's
// express.json({limit:"25mb"})) rather than over the socket, so Socket.IO's
// default per-message buffer size never needs raising. Either path ends up
// broadcasting the same 'receive_message' event to every socket in
// `room:<id>`, via the one shared insertChatMessage() helper below.

import type { Express } from "express";
import { checkSession } from "./SessionSecurity";
import type { Server as SocketIOServer } from "socket.io";
import jwt from "jsonwebtoken";
import { sendPushToRoomMembers } from "./PushNotificationService";
import { accountOnboarding } from "./OnboardingSelfServiceRoutes";

interface ChatRouteDeps {
  authenticateToken: any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
}

// Push notifications (Android, via Firebase Cloud Messaging) — see
// PushNotificationService.ts (getFirebaseApp/sendPushToRoomMembers, shared
// with Alerts.ts) for the setup steps and the "entirely optional" no-op
// behavior when FIREBASE_SERVICE_ACCOUNT_JSON isn't set.

// Fire-and-forget from both the REST POST /messages route and the socket
// 'send_message' handler right after a message is persisted+broadcast —
// never awaited there, so a slow/failed push never delays message delivery
// to the people actually online.
export async function notifyNewMessage(queryDB: ChatRouteDeps["queryDB"], message: any): Promise<void> {
  try {
    const roomRows = await queryDB("SELECT type, title FROM chat_rooms WHERE id = ?", [message.room_id]);
    const room = roomRows[0];
    if (!room) return;
    const isGroup = room.type !== "direct";
    const bodyText =
      message.message_type === "image"
        ? "📷 Photo"
        : message.message_type === "audio"
        ? "🎤 Voice message"
        : message.message_type === "file"
        ? `📎 ${message.attachment_filename || "File"}`
        : message.content || "";
    const title = isGroup ? room.title || "Group" : message.sender_name;
    const body = isGroup ? `${message.sender_name}: ${bodyText}` : bodyText;
    await sendPushToRoomMembers(queryDB, message.room_id, message.sender_id, title, body, {
      roomId: String(message.room_id),
      messageId: String(message.id)
    });
  } catch {
    // Best-effort — see sendPushToRoomMembers; a push failure never affects
    // the message itself, which is already delivered via Socket.IO/REST.
  }
}

interface ChatSocketDeps {
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  jwtSecret: string;
}

const MAX_CHAT_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB, same ceiling AssetManagementRoutes uses

// Self-healing migration — same pattern as ensureAssetManagementSchema in
// AssetManagementRoutes.ts: CREATE TABLE IF NOT EXISTS means a normal server
// restart is enough to pick this up on an already-running database, no
// manual SQL required. Called from server.ts's ensureSchemaMigrations()
// alongside every other table.
export async function ensureChatSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS chat_rooms (
        id INT AUTO_INCREMENT PRIMARY KEY,
        type ENUM('direct','group','community') NOT NULL,
        title VARCHAR(150) NULL,
        parent_room_id INT NULL,
        avatar_mimetype VARCHAR(150) NULL,
        avatar_data LONGBLOB NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (parent_room_id) REFERENCES chat_rooms(id) ON DELETE SET NULL,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS chat_room_members (
        id INT AUTO_INCREMENT PRIMARY KEY,
        room_id INT NOT NULL,
        user_id INT NOT NULL,
        role ENUM('admin','member') NOT NULL DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_chat_room_member (room_id, user_id),
        FOREIGN KEY (room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        room_id INT NOT NULL,
        sender_id INT NOT NULL,
        message_type ENUM('text','image','file','audio') NOT NULL DEFAULT 'text',
        content TEXT NULL,
        attachment_filename VARCHAR(255) NULL,
        attachment_mimetype VARCHAR(150) NULL,
        attachment_data LONGBLOB NULL,
        reply_to_id INT NULL,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE,
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (reply_to_id) REFERENCES chat_messages(id) ON DELETE SET NULL
      )
    `);
    // Adds 'audio' (voice messages) to an already-existing install's enum —
    // the CREATE TABLE above only takes effect on a fresh database.
    // Idempotent (MODIFY to the same definition is a no-op), same pattern
    // as every other enum widening in server.ts's ensureSchemaMigrations.
    try {
      await dbPool.query(`ALTER TABLE chat_messages MODIFY COLUMN message_type ENUM('text','image','file','audio') NOT NULL DEFAULT 'text'`);
    } catch (err: any) {
      console.warn("⚠️ Could not add 'audio' to chat_messages.message_type: " + err.message);
    }
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS chat_room_reads (
        room_id INT NOT NULL,
        user_id INT NOT NULL,
        last_read_message_id INT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (room_id, user_id),
        FOREIGN KEY (room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    // One row per (account, device) — a phone reinstalling the app or an
    // account signed in on two devices both get their own row. Push
    // delivery (notifyNewMessage below) is entirely best-effort: this table
    // existing doesn't mean push actually works, only that Firebase is wired
    // up — see FIREBASE_SERVICE_ACCOUNT_JSON in the module comment near
    // sendPushToRoomMembers.
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS chat_push_tokens (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        token VARCHAR(255) NOT NULL UNIQUE,
        platform VARCHAR(20) NOT NULL DEFAULT 'android',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    // Helpful for the message-history pagination query (WHERE room_id = ?
    // ORDER BY id DESC) and the unread-count aggregate (WHERE room_id = ?
    // AND sender_id != ?) below — both are hit on every room open.
    await dbPool.query(`CREATE INDEX idx_chat_messages_room ON chat_messages (room_id, id)`).catch(() => {});
    // WhatsApp-style message actions (see the routes further down):
    //   unsent_at            "Delete for everyone": the content and
    //                        attachment are wiped, everyone sees
    //                        "This message was deleted".
    //   chat_message_hidden  "Delete for me": only this account stops
    //                        seeing the message.
    //   chat_message_reactions  one emoji per (message, account).
    //   chat_wallpapers      each account's conversation background, per
    //                        room (room_id 0 = the default for every chat).
    //   users.chat_about     the "About" line on a chat profile.
    for (const [sql, ignore] of [
      ["ALTER TABLE chat_messages ADD COLUMN unsent_at TIMESTAMP NULL DEFAULT NULL", "ER_DUP_FIELDNAME"],
      ["ALTER TABLE chat_messages ADD COLUMN unsent_by INT NULL", "ER_DUP_FIELDNAME"],
      // "Edit": the sender changes a text message within 15 minutes; it then shows "Edited".
      ["ALTER TABLE chat_messages ADD COLUMN edited_at TIMESTAMP NULL DEFAULT NULL", "ER_DUP_FIELDNAME"],
      // "Forward": a copy sent on to other chats shows "Forwarded".
      ["ALTER TABLE chat_messages ADD COLUMN is_forwarded TINYINT(1) NOT NULL DEFAULT 0", "ER_DUP_FIELDNAME"],
      ["ALTER TABLE users ADD COLUMN chat_about VARCHAR(140) NULL", "ER_DUP_FIELDNAME"]
    ] as [string, string][]) {
      await dbPool.query(sql).catch((err: any) => {
        if (err?.code !== ignore) console.warn("⚠️ Chat: " + err.message);
      });
    }
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS chat_message_hidden (
        message_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (message_id, user_id),
        FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS chat_message_reactions (
        message_id INT NOT NULL,
        user_id INT NOT NULL,
        emoji VARCHAR(16) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (message_id, user_id),
        FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) DEFAULT CHARSET=utf8mb4
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS chat_wallpapers (
        user_id INT NOT NULL,
        room_id INT NOT NULL,
        wallpaper VARCHAR(32) NOT NULL,
        PRIMARY KEY (user_id, room_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure Chat tables exist: " + err.message);
  }
}

async function isMember(queryDB: ChatRouteDeps["queryDB"], roomId: number, userId: number): Promise<{ role: "admin" | "member" } | null> {
  const rows = await queryDB("SELECT role FROM chat_room_members WHERE room_id = ? AND user_id = ?", [roomId, userId]);
  return rows.length > 0 ? { role: rows[0].role } : null;
}

async function isRoomAdmin(queryDB: ChatRouteDeps["queryDB"], roomId: number, requester: { id: number; role: string }): Promise<boolean> {
  if (requester.role === "superadmin") return true;
  const membership = await isMember(queryDB, roomId, requester.id);
  return membership?.role === "admin";
}

// Existing direct room between exactly these two accounts, if any — used so
// "message this person" from a directory never creates a duplicate direct
// room every time it's opened.
async function findOrCreateDirectRoom(queryDB: ChatRouteDeps["queryDB"], userAId: number, userBId: number): Promise<number> {
  const existing = await queryDB(
    `SELECT r.id FROM chat_rooms r
     JOIN chat_room_members m1 ON m1.room_id = r.id AND m1.user_id = ?
     JOIN chat_room_members m2 ON m2.room_id = r.id AND m2.user_id = ?
     WHERE r.type = 'direct'
     LIMIT 1`,
    [userAId, userBId]
  );
  if (existing.length > 0) return existing[0].id;

  const result = await queryDB("INSERT INTO chat_rooms (type, created_by) VALUES ('direct', ?)", [userAId]);
  const roomId = result.insertId;
  await queryDB("INSERT INTO chat_room_members (room_id, user_id, role) VALUES (?, ?, 'member'), (?, ?, 'member')", [
    roomId,
    userAId,
    roomId,
    userBId
  ]);
  return roomId;
}

// Shared by the REST POST /messages route and the socket 'send_message'
// handler — see the module comment above for why text vs attachment
// messages take different transports to get here.
export async function insertChatMessage(
  queryDB: ChatRouteDeps["queryDB"],
  params: {
    roomId: number;
    senderId: number;
    messageType: "text" | "image" | "file" | "audio";
    content: string | null;
    attachmentBuffer?: Buffer | null;
    attachmentMimetype?: string | null;
    attachmentFilename?: string | null;
    replyToId?: number | null;
    forwarded?: boolean;
  }
): Promise<any> {
  const result = await queryDB(
    `INSERT INTO chat_messages
      (room_id, sender_id, message_type, content, attachment_filename, attachment_mimetype, attachment_data, reply_to_id, is_forwarded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.roomId,
      params.senderId,
      params.messageType,
      params.content ?? null,
      params.attachmentFilename ?? null,
      params.attachmentMimetype ?? null,
      params.attachmentBuffer ?? null,
      params.replyToId ?? null,
      params.forwarded ? 1 : 0
    ]
  );
  return (await loadMessages(queryDB, "cm.id = ?", [result.insertId]))[0];
}

// One shape for a message everywhere (history, send, live updates). A reply
// shows what it quotes ("This message was deleted" once that was unsent), and
// every message carries its reactions: [{ emoji, user_id, name }].
const MESSAGE_SELECT = `
  SELECT cm.id, cm.room_id, cm.sender_id, u.name AS sender_name, cm.message_type, cm.content,
         cm.attachment_filename, cm.attachment_mimetype, (cm.attachment_data IS NOT NULL) AS has_attachment,
         cm.reply_to_id, cm.created_at, cm.unsent_at, cm.edited_at, cm.is_forwarded,
         CASE WHEN rt.unsent_at IS NOT NULL THEN 'This message was deleted'
              WHEN rt.content IS NOT NULL AND rt.content <> '' THEN rt.content
              WHEN rt.message_type = 'image' THEN '📷 Photo'
              WHEN rt.message_type = 'audio' THEN '🎤 Voice message'
              WHEN rt.message_type = 'file' THEN CONCAT('📎 ', COALESCE(rt.attachment_filename, 'File'))
              ELSE rt.content END AS reply_to_content,
         rtu.name AS reply_to_sender_name
  FROM chat_messages cm
  JOIN users u ON u.id = cm.sender_id
  LEFT JOIN chat_messages rt ON rt.id = cm.reply_to_id
  LEFT JOIN users rtu ON rtu.id = rt.sender_id`;
export async function loadMessages(queryDB: ChatRouteDeps["queryDB"], where: string, params: any[], tail = ""): Promise<any[]> {
  const rows: any[] = (await queryDB(`${MESSAGE_SELECT} WHERE ${where} ${tail}`, params)) || [];
  if (!rows.length) return rows;
  const ids = rows.map((r) => Number(r.id));
  const reacts: any[] =
    (await queryDB(
      `SELECT r.message_id, r.user_id, r.emoji, u.name FROM chat_message_reactions r JOIN users u ON u.id = r.user_id
        WHERE r.message_id IN (${ids.map(() => "?").join(",")}) ORDER BY r.created_at ASC`,
      ids
    ).catch(() => [])) || [];
  const byMsg = new Map<number, any[]>();
  for (const r of reacts) {
    const list = byMsg.get(Number(r.message_id)) || [];
    list.push({ emoji: r.emoji, user_id: Number(r.user_id), name: r.name });
    byMsg.set(Number(r.message_id), list);
  }
  return rows.map((r) => ({ ...r, reactions: byMsg.get(Number(r.id)) || [] }));
}

async function upsertRead(queryDB: ChatRouteDeps["queryDB"], roomId: number, userId: number, messageId: number): Promise<void> {
  await queryDB(
    `INSERT INTO chat_room_reads (room_id, user_id, last_read_message_id)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), VALUES(last_read_message_id))`,
    [roomId, userId, messageId]
  );
}

// Chat access per account (users.can_use_chat, Module Access -> Chat; on
// unless turned off), cached briefly. A Superadmin always has it.
const chatAccessCache = new Map<number, { ok: boolean; at: number }>();
export async function canUseChat(queryDB: (sql: string, params?: any[]) => Promise<any>, userId: number): Promise<boolean> {
  const hit = chatAccessCache.get(userId);
  if (hit && Date.now() - hit.at < 30 * 1000) return hit.ok;
  const rows: any[] | null = await queryDB("SELECT role, can_use_chat FROM users WHERE id = ?", [userId]).catch(() => null);
  if (!rows) return hit?.ok ?? false;
  const u = rows[0];
  const ok = !!u && (u.role === "superadmin" || Number(u.can_use_chat ?? 1) !== 0);
  chatAccessCache.set(userId, { ok, at: Date.now() });
  return ok;
}
// SQL condition: the account in `alias` has Chat.
const CHAT_ON_SQL = (alias: string) => `(${alias}.role = 'superadmin' OR COALESCE(${alias}.can_use_chat, 1) <> 0)`;

export function registerChatRoutes(app: Express, io: SocketIOServer, deps: ChatRouteDeps) {
  const { authenticateToken, queryDB } = deps;

  // Every Chat route below needs Chat access (the push-token routes don't:
  // the app's push registration carries every other notification too).
  const requireChat = async (req: any, res: any, next: any) => {
    if (await canUseChat(queryDB, Number(req.user?.id))) return next();
    res.status(403).json({ error: "Chat is not turned on for your account. Ask your Superadmin.", code: "CHAT_OFF" });
  };
  // Of these accounts, the ones that have Chat.
  const withChat = async (ids: number[]): Promise<number[]> => {
    if (ids.length === 0) return [];
    const rows: any[] = await queryDB(`SELECT id FROM users u WHERE id IN (${ids.map(() => "?").join(",")}) AND ${CHAT_ON_SQL("u")}`, ids);
    return rows.map((r: any) => Number(r.id));
  };

  // GET /api/chat/directory — every other account, for "start a new chat" /
  // "add members" pickers. Same company-wide visibility EmployeeDirectoryRoutes.ts
  // already grants every signed-in account (chat is internal, org-wide).
  app.get("/api/chat/directory", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const rows = await queryDB(
        `SELECT id, name, email, username, role FROM users u WHERE id != ? AND ${CHAT_ON_SQL("u")} ORDER BY name ASC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/chat/rooms — every room this account belongs to, with a last-message
  // preview and unread count, newest activity first.
  app.get("/api/chat/rooms", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const rooms = await queryDB(
        `SELECT r.id, r.type, r.title, r.parent_room_id, r.created_by,
                (r.avatar_data IS NOT NULL) AS has_avatar,
                m.role AS my_role,
                lm.id AS last_message_id, IF(lm.unsent_at IS NULL, lm.content, 'This message was deleted') AS last_message_content,
                lm.message_type AS last_message_type, lm.sender_id AS last_message_sender_id,
                lm.created_at AS last_message_at
         FROM chat_room_members m
         JOIN chat_rooms r ON r.id = m.room_id
         LEFT JOIN chat_messages lm ON lm.id = (
           SELECT id FROM chat_messages WHERE room_id = r.id AND deleted_at IS NULL ORDER BY id DESC LIMIT 1
         )
         WHERE m.user_id = ?
         ORDER BY COALESCE(lm.created_at, r.created_at) DESC`,
        [userId]
      );

      const unreadRows = await queryDB(
        `SELECT cm.room_id, COUNT(*) AS unread
         FROM chat_messages cm
         JOIN chat_room_members rm ON rm.room_id = cm.room_id AND rm.user_id = ?
         LEFT JOIN chat_room_reads rr ON rr.room_id = cm.room_id AND rr.user_id = ?
         WHERE cm.sender_id != ? AND cm.deleted_at IS NULL
           AND (rr.last_read_message_id IS NULL OR cm.id > rr.last_read_message_id)
         GROUP BY cm.room_id`,
        [userId, userId, userId]
      );
      const unreadByRoom = new Map<number, number>(unreadRows.map((r: any) => [r.room_id, Number(r.unread)]));

      const directRoomIds = rooms.filter((r: any) => r.type === "direct").map((r: any) => r.id);
      const otherParticipantByRoom = new Map<number, any>();
      if (directRoomIds.length > 0) {
        const placeholders = directRoomIds.map(() => "?").join(",");
        const others = await queryDB(
          `SELECT m.room_id, u.id, u.name, u.email, u.username
           FROM chat_room_members m
           JOIN users u ON u.id = m.user_id
           WHERE m.room_id IN (${placeholders}) AND m.user_id != ?`,
          [...directRoomIds, userId]
        );
        for (const o of others) otherParticipantByRoom.set(o.room_id, o);
      }

      // This account's conversation backgrounds (room 0 = its default).
      const wp: any[] = (await queryDB("SELECT room_id, wallpaper FROM chat_wallpapers WHERE user_id = ?", [userId]).catch(() => [])) || [];
      const wallpaperOf = new Map<number, string>(wp.map((w: any) => [Number(w.room_id), String(w.wallpaper)]));
      res.json(
        rooms.map((r: any) => ({
          ...r,
          wallpaper: wallpaperOf.get(Number(r.id)) || wallpaperOf.get(0) || null,
          unread_count: unreadByRoom.get(r.id) || 0,
          other_participant: r.type === "direct" ? otherParticipantByRoom.get(r.id) || null : null
        }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/chat/unread-count — total unread across every room, for the
  // Navbar chat bell badge (same idea as AlertsBell's /api/alerts/unread-count).
  app.get("/api/chat/unread-count", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const rows = await queryDB(
        `SELECT COUNT(*) AS count
         FROM chat_messages cm
         JOIN chat_room_members rm ON rm.room_id = cm.room_id AND rm.user_id = ?
         LEFT JOIN chat_room_reads rr ON rr.room_id = cm.room_id AND rr.user_id = ?
         WHERE cm.sender_id != ? AND cm.deleted_at IS NULL
           AND (rr.last_read_message_id IS NULL OR cm.id > rr.last_read_message_id)`,
        [userId, userId, userId]
      );
      res.json({ count: Number(rows[0]?.count || 0) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/chat/rooms — create (or, for 'direct', reuse) a room.
  // Body: { type: 'direct'|'group'|'community', title?, memberIds: number[] }
  app.post("/api/chat/rooms", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { type, title, memberIds } = req.body || {};
      if (!["direct", "group", "community"].includes(type)) {
        return res.status(400).json({ error: "type must be 'direct', 'group', or 'community'." });
      }
      const asked: number[] = Array.isArray(memberIds) ? memberIds.map(Number).filter((n) => Number.isFinite(n) && n !== userId) : [];
      // Only accounts that have Chat can be chatted with or added.
      const ids = await withChat(asked);
      if (ids.length < asked.length && type === "direct") return res.status(400).json({ error: "Chat is not turned on for that account." });

      if (type === "direct") {
        if (ids.length !== 1) return res.status(400).json({ error: "Direct chat needs exactly one other member." });
        const roomId = await findOrCreateDirectRoom(queryDB, userId, ids[0]);
        return res.json({ id: roomId, type: "direct" });
      }

      if (!title || !String(title).trim()) {
        return res.status(400).json({ error: `${type === "group" ? "Group" : "Community"} name is required.` });
      }
      const result = await queryDB("INSERT INTO chat_rooms (type, title, created_by) VALUES (?, ?, ?)", [
        type,
        String(title).trim(),
        userId
      ]);
      const roomId = result.insertId;
      await queryDB("INSERT INTO chat_room_members (room_id, user_id, role) VALUES (?, ?, 'admin')", [roomId, userId]);
      for (const memberId of ids) {
        await queryDB("INSERT IGNORE INTO chat_room_members (room_id, user_id, role) VALUES (?, ?, 'member')", [
          roomId,
          memberId
        ]);
      }
      res.json({ id: roomId, type, title: String(title).trim() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/chat/rooms/:id/subgroups — attach an existing 'group' room as
  // a sub-group of this 'community' room (WhatsApp Community). Community
  // admin only. Body: { groupRoomId }
  app.post("/api/chat/rooms/:id/subgroups", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const communityId = Number(req.params.id);
      const groupRoomId = Number(req.body?.groupRoomId);
      if (!Number.isFinite(groupRoomId)) return res.status(400).json({ error: "groupRoomId is required." });

      const community = await queryDB("SELECT id, type FROM chat_rooms WHERE id = ?", [communityId]);
      if (community.length === 0 || community[0].type !== "community") {
        return res.status(404).json({ error: "Community not found." });
      }
      if (!(await isRoomAdmin(queryDB, communityId, req.user))) {
        return res.status(403).json({ error: "Only a Community admin can attach a group." });
      }
      const group = await queryDB("SELECT id, type FROM chat_rooms WHERE id = ?", [groupRoomId]);
      if (group.length === 0 || group[0].type !== "group") {
        return res.status(404).json({ error: "Group not found." });
      }
      if (!(await isRoomAdmin(queryDB, groupRoomId, req.user))) {
        return res.status(403).json({ error: "You must be an admin of that group too." });
      }
      await queryDB("UPDATE chat_rooms SET parent_room_id = ? WHERE id = ?", [communityId, groupRoomId]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/chat/rooms/:id/members
  app.get("/api/chat/rooms/:id/members", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const roomId = Number(req.params.id);
      if (!(await isMember(queryDB, roomId, req.user.id))) {
        return res.status(403).json({ error: "Not a member of this room." });
      }
      const rows = await queryDB(
        `SELECT m.user_id, u.name, u.email, u.username, m.role, m.joined_at
         FROM chat_room_members m JOIN users u ON u.id = m.user_id
         WHERE m.room_id = ? ORDER BY (m.role = 'admin') DESC, u.name ASC`,
        [roomId]
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/chat/rooms/:id/members — add members (group/community admin only).
  // Body: { userIds: number[] }
  app.post("/api/chat/rooms/:id/members", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const roomId = Number(req.params.id);
      const room = await queryDB("SELECT type FROM chat_rooms WHERE id = ?", [roomId]);
      if (room.length === 0) return res.status(404).json({ error: "Room not found." });
      if (room[0].type === "direct") return res.status(400).json({ error: "Cannot add members to a direct chat." });
      if (!(await isRoomAdmin(queryDB, roomId, req.user))) {
        return res.status(403).json({ error: "Only an admin of this room can add members." });
      }
      // Only accounts that have Chat can be added.
      const ids = await withChat(Array.isArray(req.body?.userIds) ? req.body.userIds.map(Number).filter(Number.isFinite) : []);
      for (const memberId of ids) {
        await queryDB("INSERT IGNORE INTO chat_room_members (room_id, user_id, role) VALUES (?, ?, 'member')", [
          roomId,
          memberId
        ]);
      }
      io.to(`room:${roomId}`).emit("members_changed", { roomId });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/chat/rooms/:id/members/:userId — remove a member (room admin),
  // or leave the room yourself (target === requester).
  app.delete("/api/chat/rooms/:id/members/:userId", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const roomId = Number(req.params.id);
      const targetUserId = Number(req.params.userId);
      const isSelf = targetUserId === req.user.id;
      if (!isSelf && !(await isRoomAdmin(queryDB, roomId, req.user))) {
        return res.status(403).json({ error: "Only an admin of this room can remove other members." });
      }
      await queryDB("DELETE FROM chat_room_members WHERE room_id = ? AND user_id = ?", [roomId, targetUserId]);
      io.to(`room:${roomId}`).emit("members_changed", { roomId });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/chat/rooms/:id/members/:userId — promote/demote. Body: { role: 'admin'|'member' }
  app.patch("/api/chat/rooms/:id/members/:userId", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const roomId = Number(req.params.id);
      const targetUserId = Number(req.params.userId);
      const role = req.body?.role;
      if (!["admin", "member"].includes(role)) return res.status(400).json({ error: "role must be 'admin' or 'member'." });
      if (!(await isRoomAdmin(queryDB, roomId, req.user))) {
        return res.status(403).json({ error: "Only an admin of this room can change roles." });
      }
      await queryDB("UPDATE chat_room_members SET role = ? WHERE room_id = ? AND user_id = ?", [role, roomId, targetUserId]);
      io.to(`room:${roomId}`).emit("members_changed", { roomId });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/chat/rooms/:id/messages?beforeId=&limit= — newest-first page;
  // pass the oldest id already loaded as beforeId to load the next page back.
  app.get("/api/chat/rooms/:id/messages", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const roomId = Number(req.params.id);
      if (!(await isMember(queryDB, roomId, req.user.id))) {
        return res.status(403).json({ error: "Not a member of this room." });
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      const beforeId = req.query.beforeId ? Number(req.query.beforeId) : null;
      // Leaves out what this account deleted for itself ("Delete for me").
      const rows = await loadMessages(
        queryDB,
        `cm.room_id = ? AND cm.deleted_at IS NULL ${beforeId ? "AND cm.id < ?" : ""}
         AND NOT EXISTS (SELECT 1 FROM chat_message_hidden h WHERE h.message_id = cm.id AND h.user_id = ?)`,
        // LIMIT is written in (an integer clamped above) rather than bound:
        // MySQL 8.0.22+ refuses a bound LIMIT that the driver sends as a
        // double ("Incorrect arguments to mysqld_stmt_execute").
        beforeId ? [roomId, beforeId, req.user.id] : [roomId, req.user.id],
        `ORDER BY cm.id DESC LIMIT ${limit}`
      );
      res.json(rows.reverse()); // oldest-first, ready to append/prepend in the UI
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/chat/rooms/:id/messages — REST send path, used for image/file
  // messages (base64 body) and as a fallback when the socket isn't connected.
  // Body: { content?, messageType, attachment_base64?, attachment_mimetype?,
  //          attachment_filename?, replyToId? }
  app.post("/api/chat/rooms/:id/messages", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const roomId = Number(req.params.id);
      if (!(await isMember(queryDB, roomId, req.user.id))) {
        return res.status(403).json({ error: "Not a member of this room." });
      }
      const { content, messageType, attachment_base64, attachment_mimetype, attachment_filename, replyToId } = req.body || {};
      const type = ["text", "image", "file", "audio"].includes(messageType) ? messageType : "text";
      let attachmentBuffer: Buffer | null = null;
      if (attachment_base64) {
        attachmentBuffer = Buffer.from(attachment_base64, "base64");
        if (attachmentBuffer.length > MAX_CHAT_ATTACHMENT_BYTES) {
          return res.status(400).json({ error: "Attachment must be less than 5MB." });
        }
      }
      if (!content && !attachmentBuffer) return res.status(400).json({ error: "Empty message." });

      const message = await insertChatMessage(queryDB, {
        roomId,
        senderId: req.user.id,
        messageType: type,
        content: content ? String(content) : null,
        attachmentBuffer,
        attachmentMimetype: attachment_mimetype || null,
        attachmentFilename: attachment_filename || null,
        replyToId: replyToId ? Number(replyToId) : null
      });
      io.to(`room:${roomId}`).emit("receive_message", message);
      void notifyNewMessage(queryDB, message);
      res.json(message);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/chat/messages/:id/attachment — stream the blob, same
  // Content-Type/Cache-Control convention as profileRoutes.ts's photo GET.
  app.get("/api/chat/messages/:id/attachment", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const messageId = Number(req.params.id);
      const rows = await queryDB(
        "SELECT room_id, attachment_mimetype, attachment_data, attachment_filename FROM chat_messages WHERE id = ? AND unsent_at IS NULL",
        [messageId]
      );
      const row = rows[0];
      if (!row || !row.attachment_data) return res.status(404).json({ error: "No attachment on this message." });
      if (!(await isMember(queryDB, row.room_id, req.user.id))) {
        return res.status(403).json({ error: "Not a member of this room." });
      }
      const buffer: Buffer = Buffer.isBuffer(row.attachment_data) ? row.attachment_data : Buffer.from(row.attachment_data);
      res.setHeader("Content-Type", row.attachment_mimetype || "application/octet-stream");
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      if (row.attachment_filename) {
        res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(row.attachment_filename)}"`);
      }
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/chat/rooms/:id/read — mark everything up to messageId read.
  app.post("/api/chat/rooms/:id/read", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const roomId = Number(req.params.id);
      const messageId = Number(req.body?.messageId);
      if (!Number.isFinite(messageId)) return res.status(400).json({ error: "messageId is required." });
      if (!(await isMember(queryDB, roomId, req.user.id))) {
        return res.status(403).json({ error: "Not a member of this room." });
      }
      await upsertRead(queryDB, roomId, req.user.id, messageId);
      io.to(`room:${roomId}`).emit("message_read", { roomId, userId: req.user.id, messageId });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/chat/messages/:id/reads — who has read at least up through this
  // message (chat_room_reads.last_read_message_id >= this id), excluding the
  // sender. Used for the group "Seen by ..." line under your own latest
  // message — WhatsApp shows this per-message via long-press; this app shows
  // it inline for just the sender's own most recent message, which is what
  // the ChatPanel UI actually renders (see the module comment there).
  app.get("/api/chat/messages/:id/reads", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const messageId = Number(req.params.id);
      const msgRows = await queryDB("SELECT room_id, sender_id FROM chat_messages WHERE id = ?", [messageId]);
      const msg = msgRows[0];
      if (!msg) return res.status(404).json({ error: "Message not found." });
      if (!(await isMember(queryDB, msg.room_id, req.user.id))) {
        return res.status(403).json({ error: "Not a member of this room." });
      }
      const rows = await queryDB(
        `SELECT u.id, u.name, rr.updated_at AS read_at
         FROM chat_room_reads rr JOIN users u ON u.id = rr.user_id
         WHERE rr.room_id = ? AND rr.user_id != ? AND rr.last_read_message_id >= ?
         ORDER BY rr.updated_at ASC`,
        [msg.room_id, msg.sender_id, messageId]
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- WhatsApp-style message actions -------------------------------------
  const UNSEND_WINDOW_MS = 48 * 60 * 60 * 1000;
  const messageRow = async (id: number) => ((await queryDB("SELECT id, room_id, sender_id, message_type, content, created_at, unsent_at FROM chat_messages WHERE id = ?", [id])) || [])[0];
  const EDIT_WINDOW_MS = 15 * 60 * 1000;

  // POST /api/chat/messages/:id/edit — { content }: the sender changes a text
  // message within 15 minutes of sending (like WhatsApp); it shows "Edited".
  app.post("/api/chat/messages/:id/edit", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const msg = await messageRow(Number(req.params.id));
      if (!msg) return res.status(404).json({ error: "Message not found." });
      if (!(await isMember(queryDB, msg.room_id, req.user.id))) return res.status(403).json({ error: "Not a member of this room." });
      if (Number(msg.sender_id) !== Number(req.user.id)) return res.status(403).json({ error: "You can only edit your own messages." });
      if (msg.unsent_at) return res.status(400).json({ error: "This message was deleted." });
      if (msg.message_type !== "text") return res.status(400).json({ error: "Only text messages can be edited." });
      if (Date.now() - new Date(msg.created_at).getTime() > EDIT_WINDOW_MS) return res.status(400).json({ error: "Too late to edit — a message can be edited within 15 minutes of sending." });
      const content = String(req.body?.content ?? "").trim();
      if (!content) return res.status(400).json({ error: "The message can't be empty." });
      if (content === String(msg.content || "")) return res.json({ unchanged: true });
      await queryDB("UPDATE chat_messages SET content = ?, edited_at = NOW() WHERE id = ?", [content, msg.id]);
      const [updated] = await loadMessages(queryDB, "cm.id = ?", [msg.id]);
      io.to(`room:${msg.room_id}`).emit("message_edited", { roomId: msg.room_id, messageId: msg.id, content: updated.content, edited_at: updated.edited_at });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/chat/messages/:id/forward — { roomIds, userIds }: a copy of
  // the message (text and / or attachment) goes to up to 5 chats this
  // account is in, or to people (their direct chat, made if needed). The
  // copies show "Forwarded" and carry no reply quote.
  app.post("/api/chat/messages/:id/forward", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const src: any = ((await queryDB(
        "SELECT id, room_id, message_type, content, attachment_filename, attachment_mimetype, attachment_data, unsent_at FROM chat_messages WHERE id = ? AND deleted_at IS NULL",
        [Number(req.params.id)]
      )) || [])[0];
      if (!src) return res.status(404).json({ error: "Message not found." });
      if (!(await isMember(queryDB, src.room_id, req.user.id))) return res.status(403).json({ error: "Not a member of this room." });
      if (src.unsent_at) return res.status(400).json({ error: "This message was deleted." });
      const toNum = (v: any) => (Array.isArray(v) ? v : []).map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
      const roomIds = new Set<number>(toNum(req.body?.roomIds));
      const people = await withChat(toNum(req.body?.userIds).filter((n: number) => n !== Number(req.user.id)));
      for (const uid of people) roomIds.add(await findOrCreateDirectRoom(queryDB, Number(req.user.id), uid));
      if (!roomIds.size) return res.status(400).json({ error: "Pick at least one chat." });
      if (roomIds.size > 5) return res.status(400).json({ error: "You can forward to up to 5 chats at a time." });
      const sent: number[] = [];
      for (const roomId of roomIds) {
        if (!(await isMember(queryDB, roomId, req.user.id))) continue;
        const message = await insertChatMessage(queryDB, {
          roomId,
          senderId: req.user.id,
          messageType: src.message_type,
          content: src.content,
          attachmentBuffer: src.attachment_data ? (Buffer.isBuffer(src.attachment_data) ? src.attachment_data : Buffer.from(src.attachment_data)) : null,
          attachmentMimetype: src.attachment_mimetype,
          attachmentFilename: src.attachment_filename,
          forwarded: true
        });
        // A direct chat just made for this: its sockets join the room now.
        io.in(`user:${req.user.id}`).socketsJoin(`room:${roomId}`);
        const others: any[] = (await queryDB("SELECT user_id FROM chat_room_members WHERE room_id = ?", [roomId])) || [];
        for (const o of others) io.in(`user:${o.user_id}`).socketsJoin(`room:${roomId}`);
        io.to(`room:${roomId}`).emit("receive_message", message);
        void notifyNewMessage(queryDB, message);
        sent.push(roomId);
      }
      res.json({ forwarded: sent.length, roomIds: sent });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/chat/messages/:id/react — { emoji } sets this account's one
  // reaction (the same emoji again, or emoji null, takes it off).
  app.post("/api/chat/messages/:id/react", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const msg = await messageRow(Number(req.params.id));
      if (!msg) return res.status(404).json({ error: "Message not found." });
      if (!(await isMember(queryDB, msg.room_id, req.user.id))) return res.status(403).json({ error: "Not a member of this room." });
      if (msg.unsent_at) return res.status(400).json({ error: "This message was deleted." });
      const emoji = req.body?.emoji ? String(req.body.emoji).trim().slice(0, 16) : "";
      const mine: any[] = await queryDB("SELECT emoji FROM chat_message_reactions WHERE message_id = ? AND user_id = ?", [msg.id, req.user.id]);
      if (!emoji || mine[0]?.emoji === emoji) {
        await queryDB("DELETE FROM chat_message_reactions WHERE message_id = ? AND user_id = ?", [msg.id, req.user.id]);
      } else {
        await queryDB(
          "INSERT INTO chat_message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE emoji = VALUES(emoji), created_at = CURRENT_TIMESTAMP",
          [msg.id, req.user.id, emoji]
        );
      }
      const [updated] = await loadMessages(queryDB, "cm.id = ?", [msg.id]);
      io.to(`room:${msg.room_id}`).emit("message_reactions", { roomId: msg.room_id, messageId: msg.id, reactions: updated?.reactions || [] });
      res.json({ reactions: updated?.reactions || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/chat/messages/:id/unsend — "Delete for everyone": the sender
  // within 48 hours, or an admin of the group / community at any time.
  // The text and attachment are wiped; everyone sees "This message was deleted".
  app.post("/api/chat/messages/:id/unsend", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const msg = await messageRow(Number(req.params.id));
      if (!msg) return res.status(404).json({ error: "Message not found." });
      if (!(await isMember(queryDB, msg.room_id, req.user.id))) return res.status(403).json({ error: "Not a member of this room." });
      if (msg.unsent_at) return res.json({ success: true });
      const own = Number(msg.sender_id) === Number(req.user.id);
      const room = ((await queryDB("SELECT type FROM chat_rooms WHERE id = ?", [msg.room_id])) || [])[0];
      const asAdmin = room && room.type !== "direct" && (await isRoomAdmin(queryDB, msg.room_id, req.user));
      if (!own && !asAdmin) return res.status(403).json({ error: "You can only delete your own messages for everyone." });
      if (own && !asAdmin && Date.now() - new Date(msg.created_at).getTime() > UNSEND_WINDOW_MS) {
        return res.status(400).json({ error: "Too late to delete for everyone (48 hours) — you can still delete it for yourself." });
      }
      await queryDB(
        "UPDATE chat_messages SET unsent_at = NOW(), unsent_by = ?, content = NULL, attachment_data = NULL, attachment_filename = NULL, attachment_mimetype = NULL WHERE id = ?",
        [req.user.id, msg.id]
      );
      await queryDB("DELETE FROM chat_message_reactions WHERE message_id = ?", [msg.id]);
      io.to(`room:${msg.room_id}`).emit("message_unsent", { roomId: msg.room_id, messageId: msg.id });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/chat/messages/hide — "Delete for me": { messageIds } leave this
  // account's view only.
  app.post("/api/chat/messages/hide", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const ids = [...new Set<number>((Array.isArray(req.body?.messageIds) ? req.body.messageIds : []).map(Number).filter((n: number) => n > 0))].slice(0, 200);
      let hidden = 0;
      for (const id of ids) {
        const msg = await messageRow(id);
        if (!msg || !(await isMember(queryDB, msg.room_id, req.user.id))) continue;
        await queryDB("INSERT IGNORE INTO chat_message_hidden (message_id, user_id) VALUES (?, ?)", [id, req.user.id]);
        hidden++;
      }
      res.json({ hidden });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/chat/rooms/:id/wallpaper — { wallpaper, forAll } this
  // account's background for one conversation, or (forAll) its default for
  // every chat (clears the per-chat ones). wallpaper null = back to default.
  const WALLPAPERS = new Set(["frosted", "doodle", "plain", "mint", "sky", "blush", "lavender", "sand", "slate"]);
  app.put("/api/chat/rooms/:id/wallpaper", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const roomId = Number(req.params.id);
      const forAll = !!req.body?.forAll;
      const wallpaper = req.body?.wallpaper ? String(req.body.wallpaper) : null;
      if (wallpaper && !WALLPAPERS.has(wallpaper)) return res.status(400).json({ error: "Unknown wallpaper." });
      if (!forAll && !(await isMember(queryDB, roomId, req.user.id))) return res.status(403).json({ error: "Not a member of this room." });
      const target = forAll ? 0 : roomId;
      if (forAll) await queryDB("DELETE FROM chat_wallpapers WHERE user_id = ?", [req.user.id]);
      if (wallpaper) {
        await queryDB("INSERT INTO chat_wallpapers (user_id, room_id, wallpaper) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE wallpaper = VALUES(wallpaper)", [req.user.id, target, wallpaper]);
      } else {
        await queryDB("DELETE FROM chat_wallpapers WHERE user_id = ? AND room_id = ?", [req.user.id, target]);
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET/PUT /api/chat/me/about — this account's "About" line.
  app.get("/api/chat/me/about", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const rows: any[] = await queryDB("SELECT chat_about FROM users WHERE id = ?", [req.user.id]);
      res.json({ about: rows[0]?.chat_about || "" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.put("/api/chat/me/about", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const about = String(req.body?.about ?? "").trim().slice(0, 140);
      await queryDB("UPDATE users SET chat_about = ? WHERE id = ?", [about || null, req.user.id]);
      res.json({ about });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/chat/rooms/:id/profile — what the conversation's info page
  // shows. A direct chat: the other person (name, About, and the same
  // directory-safe work details Employee Directory shows everyone —
  // designation, department, work email / phone, branch), common groups.
  // Any room: its shared photos, files and voice messages (newest 60).
  app.get("/api/chat/rooms/:id/profile", authenticateToken, requireChat, async (req: any, res) => {
    try {
      const roomId = Number(req.params.id);
      if (!(await isMember(queryDB, roomId, req.user.id))) return res.status(403).json({ error: "Not a member of this room." });
      const room = ((await queryDB("SELECT id, type, title, created_at FROM chat_rooms WHERE id = ?", [roomId])) || [])[0];
      if (!room) return res.status(404).json({ error: "Room not found." });
      let person: any = null;
      let commonGroups: any[] = [];
      if (room.type === "direct") {
        const other = ((await queryDB(
          "SELECT u.id, u.name, u.email, u.username, u.chat_about FROM chat_room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? AND m.user_id <> ? LIMIT 1",
          [roomId, req.user.id]
        )) || [])[0];
        if (other) {
          const emp = ((await queryDB(
            "/*unscoped*/ SELECT designation, department, email, phone, mobile, branch, employee_id FROM all_employees WHERE user_id = ? ORDER BY is_active DESC LIMIT 1",
            [other.id]
          ).catch(() => [])) || [])[0];
          person = {
            id: Number(other.id),
            name: other.name,
            username: other.username || "",
            about: other.chat_about || "",
            email: emp?.email || other.email || "",
            phone: emp?.mobile || emp?.phone || "",
            designation: emp?.designation || "",
            department: emp?.department || "",
            branch: emp?.branch || "",
            employee_id: emp?.employee_id || ""
          };
          commonGroups = (await queryDB(
            `SELECT r.id, r.type, r.title FROM chat_rooms r
              JOIN chat_room_members a ON a.room_id = r.id AND a.user_id = ?
              JOIN chat_room_members b ON b.room_id = r.id AND b.user_id = ?
             WHERE r.type <> 'direct' ORDER BY r.title`,
            [req.user.id, other.id]
          )) || [];
        }
      }
      const media: any[] =
        (await queryDB(
          `SELECT cm.id, cm.message_type, cm.attachment_filename, cm.created_at, u.name AS sender_name
             FROM chat_messages cm JOIN users u ON u.id = cm.sender_id
            WHERE cm.room_id = ? AND cm.deleted_at IS NULL AND cm.unsent_at IS NULL AND cm.attachment_data IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM chat_message_hidden h WHERE h.message_id = cm.id AND h.user_id = ?)
            ORDER BY cm.id DESC LIMIT 60`,
          [roomId, req.user.id]
        )) || [];
      res.json({ room: { id: room.id, type: room.type, title: room.title, created_at: room.created_at }, person, commonGroups, media });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/chat/push-token — register/refresh this device's FCM token
  // (see src/lib/pushNotifications.ts). No-ops usefully even without
  // Firebase configured — the token just sits unused in chat_push_tokens
  // until FIREBASE_SERVICE_ACCOUNT_JSON is set, see notifyNewMessage above.
  app.post("/api/chat/push-token", authenticateToken, async (req: any, res) => {
    try {
      const { token, platform } = req.body || {};
      if (!token || typeof token !== "string") return res.status(400).json({ error: "token is required." });
      await queryDB(
        `INSERT INTO chat_push_tokens (user_id, token, platform) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform)`,
        [req.user.id, token, platform || "android"]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/chat/push-token — called on logout so a shared/reused device
  // stops receiving this account's pushes once signed out.
  app.delete("/api/chat/push-token", authenticateToken, async (req: any, res) => {
    try {
      const { token } = req.body || {};
      if (!token) return res.status(400).json({ error: "token is required." });
      await queryDB("DELETE FROM chat_push_tokens WHERE token = ? AND user_id = ?", [token, req.user.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}

// Socket.IO wiring — see the module comment above for the text-over-socket /
// attachment-over-REST split. Called once from server.ts right after the
// shared httpServer is created.
export function setupChatSocket(io: SocketIOServer, deps: ChatSocketDeps) {
  const { queryDB, jwtSecret } = deps;
  // Presence is read from Socket.IO itself (fetchSockets), not a list kept
  // in this process: with several PM2 workers + the Redis adapter it asks
  // every worker, so someone connected to another worker still shows as
  // online; with one process it is the same local answer as before.
  // "online"/"offline" only flips on a user's first connect / last
  // disconnect (several tabs/devices can be connected at once).
  const socketsOfUser = async (userId: number) => {
    try {
      return (await io.in(`user:${userId}`).fetchSockets()).length;
    } catch {
      return 0;
    }
  };

  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as any)?.token as string | undefined;
      if (!token) return next(new Error("Authentication required"));
      const payload: any = jwt.verify(token, jwtSecret);
      // Same rule as every request (logged out, ended, unused too long).
      if (await checkSession(queryDB, token, payload)) return next(new Error("Session ended"));
      // A new joiner's temporary login has no chat or calls (OnboardingSelfServiceRoutes.ts).
      if (payload?.onb || (await accountOnboarding(queryDB, Number(payload?.id)))) return next(new Error("Not available during onboarding"));
      (socket.data as any).user = payload;
      next();
    } catch {
      next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", async (socket) => {
    const user = (socket.data as any).user;
    const userId = Number(user.id);
    socket.join(`user:${userId}`);

    if ((await socketsOfUser(userId)) === 1) io.emit("presence_change", { userId, online: true });

    // Auto-join every room this account belongs to so 'receive_message' /
    // 'user_typing' / 'message_read' reach it without a 'join_room' round
    // trip per room on every reconnect.
    // An account without Chat joins no room (this socket still carries its
    // alerts, mail and notices).
    const chatOn = () => canUseChat(queryDB, userId);
    try {
      const rooms = (await chatOn()) ? await queryDB("SELECT room_id FROM chat_room_members WHERE user_id = ?", [userId]) : [];
      for (const r of rooms) socket.join(`room:${r.room_id}`);
    } catch {
      // Best-effort — a room missed here still gets joined the next time
      // GET /api/chat/rooms is called and the UI opens it (join_room below).
    }

    // Everyone online right now (ChatPanel asks when it opens, since
    // presence_change only reports changes).
    socket.on("presence_list", async (ack?: (ids: number[]) => void) => {
      if (typeof ack !== "function") return;
      if (!(await chatOn())) return ack([]);
      io.fetchSockets()
        .then((all) => ack(Array.from(new Set(all.map((x) => Number((x.data as any)?.user?.id)).filter((id) => id > 0)))))
        .catch(() => ack([]));
    });

    socket.on("join_room", async (roomId: number) => {
      try {
        if (!(await chatOn())) return;
        const member = await queryDB("SELECT id FROM chat_room_members WHERE room_id = ? AND user_id = ?", [roomId, userId]);
        if (member.length > 0) socket.join(`room:${roomId}`);
      } catch {
        // Ignore — the room simply won't receive this socket's live updates.
      }
    });

    socket.on("typing", async (data: { roomId: number; isTyping: boolean }) => {
      const roomId = Number(data?.roomId);
      // Only into a room this socket joined as a member.
      if (!Number.isFinite(roomId) || !socket.rooms.has(`room:${roomId}`) || !(await chatOn())) return;
      socket.to(`room:${roomId}`).emit("user_typing", { roomId, userId, isTyping: !!data.isTyping });
    });

    // Text-only — see module comment for why image/file always goes via REST.
    socket.on(
      "send_message",
      async (data: { roomId: number; content: string; replyToId?: number | null }, ack?: (res: any) => void) => {
        try {
          const roomId = Number(data?.roomId);
          if (!(await chatOn())) throw new Error("Chat is not turned on for your account.");
          const member = await queryDB("SELECT id FROM chat_room_members WHERE room_id = ? AND user_id = ?", [roomId, userId]);
          if (member.length === 0) throw new Error("Not a member of this room.");
          const content = String(data?.content || "").trim();
          if (!content) throw new Error("Empty message.");
          const message = await insertChatMessage(queryDB, {
            roomId,
            senderId: userId,
            messageType: "text",
            content,
            replyToId: data.replyToId ? Number(data.replyToId) : null
          });
          io.to(`room:${roomId}`).emit("receive_message", message);
          void notifyNewMessage(queryDB, message);
          if (ack) ack({ ok: true, message });
        } catch (err: any) {
          if (ack) ack({ ok: false, error: err.message });
        }
      }
    );

    socket.on("mark_read", async (data: { roomId: number; messageId: number }) => {
      try {
        const roomId = Number(data?.roomId);
        const messageId = Number(data?.messageId);
        if (!Number.isFinite(roomId) || !Number.isFinite(messageId)) return;
        if (!socket.rooms.has(`room:${roomId}`) || !(await chatOn())) return;
        await upsertRead(queryDB, roomId, userId, messageId);
        io.to(`room:${roomId}`).emit("message_read", { roomId, userId, messageId });
      } catch {
        // Best-effort — a missed read receipt is corrected by the next one.
      }
    });

    socket.on("disconnect", async () => {
      // This socket has already left its rooms here.
      if ((await socketsOfUser(userId)) === 0) io.emit("presence_change", { userId, online: false });
    });
  });
}
