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
import type { Server as SocketIOServer } from "socket.io";
import jwt from "jsonwebtoken";

interface ChatRouteDeps {
  authenticateToken: any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
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
        message_type ENUM('text','image','file') NOT NULL DEFAULT 'text',
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
    // Helpful for the message-history pagination query (WHERE room_id = ?
    // ORDER BY id DESC) and the unread-count aggregate (WHERE room_id = ?
    // AND sender_id != ?) below — both are hit on every room open.
    await dbPool.query(`CREATE INDEX idx_chat_messages_room ON chat_messages (room_id, id)`).catch(() => {});
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
async function insertChatMessage(
  queryDB: ChatRouteDeps["queryDB"],
  params: {
    roomId: number;
    senderId: number;
    messageType: "text" | "image" | "file";
    content: string | null;
    attachmentBuffer?: Buffer | null;
    attachmentMimetype?: string | null;
    attachmentFilename?: string | null;
    replyToId?: number | null;
  }
): Promise<any> {
  const result = await queryDB(
    `INSERT INTO chat_messages
      (room_id, sender_id, message_type, content, attachment_filename, attachment_mimetype, attachment_data, reply_to_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.roomId,
      params.senderId,
      params.messageType,
      params.content ?? null,
      params.attachmentFilename ?? null,
      params.attachmentMimetype ?? null,
      params.attachmentBuffer ?? null,
      params.replyToId ?? null
    ]
  );
  const rows = await queryDB(
    `SELECT cm.id, cm.room_id, cm.sender_id, u.name AS sender_name, cm.message_type, cm.content,
            cm.attachment_filename, cm.attachment_mimetype, (cm.attachment_data IS NOT NULL) AS has_attachment,
            cm.reply_to_id, cm.created_at,
            rt.content AS reply_to_content, rtu.name AS reply_to_sender_name
     FROM chat_messages cm
     JOIN users u ON u.id = cm.sender_id
     LEFT JOIN chat_messages rt ON rt.id = cm.reply_to_id
     LEFT JOIN users rtu ON rtu.id = rt.sender_id
     WHERE cm.id = ?`,
    [result.insertId]
  );
  return rows[0];
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

export function registerChatRoutes(app: Express, io: SocketIOServer, deps: ChatRouteDeps) {
  const { authenticateToken, queryDB } = deps;

  // GET /api/chat/directory — every other account, for "start a new chat" /
  // "add members" pickers. Same company-wide visibility EmployeeDirectoryRoutes.ts
  // already grants every signed-in account (chat is internal, org-wide).
  app.get("/api/chat/directory", authenticateToken, async (req: any, res) => {
    try {
      const rows = await queryDB(
        "SELECT id, name, email, username, role FROM users WHERE id != ? ORDER BY name ASC",
        [req.user.id]
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/chat/rooms — every room this account belongs to, with a last-message
  // preview and unread count, newest activity first.
  app.get("/api/chat/rooms", authenticateToken, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const rooms = await queryDB(
        `SELECT r.id, r.type, r.title, r.parent_room_id, r.created_by,
                (r.avatar_data IS NOT NULL) AS has_avatar,
                m.role AS my_role,
                lm.id AS last_message_id, lm.content AS last_message_content,
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

      res.json(
        rooms.map((r: any) => ({
          ...r,
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
  app.get("/api/chat/unread-count", authenticateToken, async (req: any, res) => {
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
  app.post("/api/chat/rooms", authenticateToken, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { type, title, memberIds } = req.body || {};
      if (!["direct", "group", "community"].includes(type)) {
        return res.status(400).json({ error: "type must be 'direct', 'group', or 'community'." });
      }
      const ids: number[] = Array.isArray(memberIds) ? memberIds.map(Number).filter((n) => Number.isFinite(n) && n !== userId) : [];

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
  app.post("/api/chat/rooms/:id/subgroups", authenticateToken, async (req: any, res) => {
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
  app.get("/api/chat/rooms/:id/members", authenticateToken, async (req: any, res) => {
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
  app.post("/api/chat/rooms/:id/members", authenticateToken, async (req: any, res) => {
    try {
      const roomId = Number(req.params.id);
      const room = await queryDB("SELECT type FROM chat_rooms WHERE id = ?", [roomId]);
      if (room.length === 0) return res.status(404).json({ error: "Room not found." });
      if (room[0].type === "direct") return res.status(400).json({ error: "Cannot add members to a direct chat." });
      if (!(await isRoomAdmin(queryDB, roomId, req.user))) {
        return res.status(403).json({ error: "Only an admin of this room can add members." });
      }
      const ids: number[] = Array.isArray(req.body?.userIds) ? req.body.userIds.map(Number).filter(Number.isFinite) : [];
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
  app.delete("/api/chat/rooms/:id/members/:userId", authenticateToken, async (req: any, res) => {
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
  app.patch("/api/chat/rooms/:id/members/:userId", authenticateToken, async (req: any, res) => {
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
  app.get("/api/chat/rooms/:id/messages", authenticateToken, async (req: any, res) => {
    try {
      const roomId = Number(req.params.id);
      if (!(await isMember(queryDB, roomId, req.user.id))) {
        return res.status(403).json({ error: "Not a member of this room." });
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      const beforeId = req.query.beforeId ? Number(req.query.beforeId) : null;
      const rows = await queryDB(
        `SELECT cm.id, cm.room_id, cm.sender_id, u.name AS sender_name, cm.message_type, cm.content,
                cm.attachment_filename, cm.attachment_mimetype, (cm.attachment_data IS NOT NULL) AS has_attachment,
                cm.reply_to_id, cm.created_at,
                rt.content AS reply_to_content, rtu.name AS reply_to_sender_name
         FROM chat_messages cm
         JOIN users u ON u.id = cm.sender_id
         LEFT JOIN chat_messages rt ON rt.id = cm.reply_to_id
         LEFT JOIN users rtu ON rtu.id = rt.sender_id
         WHERE cm.room_id = ? AND cm.deleted_at IS NULL ${beforeId ? "AND cm.id < ?" : ""}
         ORDER BY cm.id DESC LIMIT ?`,
        beforeId ? [roomId, beforeId, limit] : [roomId, limit]
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
  app.post("/api/chat/rooms/:id/messages", authenticateToken, async (req: any, res) => {
    try {
      const roomId = Number(req.params.id);
      if (!(await isMember(queryDB, roomId, req.user.id))) {
        return res.status(403).json({ error: "Not a member of this room." });
      }
      const { content, messageType, attachment_base64, attachment_mimetype, attachment_filename, replyToId } = req.body || {};
      const type = ["text", "image", "file"].includes(messageType) ? messageType : "text";
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
      res.json(message);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/chat/messages/:id/attachment — stream the blob, same
  // Content-Type/Cache-Control convention as profileRoutes.ts's photo GET.
  app.get("/api/chat/messages/:id/attachment", authenticateToken, async (req: any, res) => {
    try {
      const messageId = Number(req.params.id);
      const rows = await queryDB(
        "SELECT room_id, attachment_mimetype, attachment_data, attachment_filename FROM chat_messages WHERE id = ?",
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
  app.post("/api/chat/rooms/:id/read", authenticateToken, async (req: any, res) => {
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
}

// Socket.IO wiring — see the module comment above for the text-over-socket /
// attachment-over-REST split. Called once from server.ts right after the
// shared httpServer is created.
export function setupChatSocket(io: SocketIOServer, deps: ChatSocketDeps) {
  const { queryDB, jwtSecret } = deps;
  // userId -> live socket ids for that account (more than one tab/device can
  // be connected at once) — presence only flips to "online"/"offline" on the
  // first connect / last disconnect for that user, not every socket.
  const onlineSockets = new Map<number, Set<string>>();

  io.use((socket, next) => {
    try {
      const token = (socket.handshake.auth as any)?.token as string | undefined;
      if (!token) return next(new Error("Authentication required"));
      const payload: any = jwt.verify(token, jwtSecret);
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

    let sockets = onlineSockets.get(userId);
    if (!sockets) {
      sockets = new Set();
      onlineSockets.set(userId, sockets);
    }
    sockets.add(socket.id);
    if (sockets.size === 1) io.emit("presence_change", { userId, online: true });

    // Auto-join every room this account belongs to so 'receive_message' /
    // 'user_typing' / 'message_read' reach it without a 'join_room' round
    // trip per room on every reconnect.
    try {
      const rooms = await queryDB("SELECT room_id FROM chat_room_members WHERE user_id = ?", [userId]);
      for (const r of rooms) socket.join(`room:${r.room_id}`);
    } catch {
      // Best-effort — a room missed here still gets joined the next time
      // GET /api/chat/rooms is called and the UI opens it (join_room below).
    }

    socket.on("join_room", async (roomId: number) => {
      try {
        const member = await queryDB("SELECT id FROM chat_room_members WHERE room_id = ? AND user_id = ?", [roomId, userId]);
        if (member.length > 0) socket.join(`room:${roomId}`);
      } catch {
        // Ignore — the room simply won't receive this socket's live updates.
      }
    });

    socket.on("typing", (data: { roomId: number; isTyping: boolean }) => {
      const roomId = Number(data?.roomId);
      if (!Number.isFinite(roomId)) return;
      socket.to(`room:${roomId}`).emit("user_typing", { roomId, userId, isTyping: !!data.isTyping });
    });

    // Text-only — see module comment for why image/file always goes via REST.
    socket.on(
      "send_message",
      async (data: { roomId: number; content: string; replyToId?: number | null }, ack?: (res: any) => void) => {
        try {
          const roomId = Number(data?.roomId);
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
        await upsertRead(queryDB, roomId, userId, messageId);
        io.to(`room:${roomId}`).emit("message_read", { roomId, userId, messageId });
      } catch {
        // Best-effort — a missed read receipt is corrected by the next one.
      }
    });

    socket.on("disconnect", () => {
      const set = onlineSockets.get(userId);
      if (!set) return;
      set.delete(socket.id);
      if (set.size === 0) {
        onlineSockets.delete(userId);
        io.emit("presence_change", { userId, online: false });
      }
    });
  });
}
