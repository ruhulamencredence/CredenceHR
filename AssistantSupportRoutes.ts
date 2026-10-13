// Assistant live support — from the Credence Assistant chat a person can ask
// for a real human. The request waits in a queue; a support agent picks it up
// and they chat in real time inside the Assistant panel (Socket.IO, the same
// connection Chat uses: every socket is in its "user:<id>" room). The agent
// can hand the conversation to another agent (transfer).
//
// Who answers ("agents"): every Superadmin, plus any Admin/User account given
// users.can_handle_assistant_support (Module Access -> "Assistant live
// support", OFF by default). Only agents see the queue; a person only ever
// sees their own conversation. Sessions are kept per group (workspace) so
// one group's chats never show up in another's queue.

import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";
import { activeCompanyId, activeGroupId } from "./companyContext";
import { createAlert } from "./Alerts";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface Deps {
  authenticateToken: any;
  queryDB: QueryDB;
  io: SocketIOServer;
}

export async function ensureAssistantSupportSchema(queryDB: QueryDB) {
  await queryDB(`CREATE TABLE IF NOT EXISTS assistant_support_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL DEFAULT 1,
    company_id INT NOT NULL DEFAULT 1,
    user_id INT NOT NULL,
    agent_id INT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'waiting',
    topic VARCHAR(300) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    accepted_at DATETIME NULL,
    closed_at DATETIME NULL,
    closed_by INT NULL,
    last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ass_group_status (group_id, status),
    INDEX idx_ass_user (user_id),
    INDEX idx_ass_agent (agent_id)
  )`);
  await queryDB(`CREATE TABLE IF NOT EXISTS assistant_support_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    sender_id INT NULL,
    kind VARCHAR(12) NOT NULL DEFAULT 'user',
    body TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_asm_session (session_id)
  )`);
}

const OPEN = ["waiting", "active"];

export function registerAssistantSupportRoutes(app: Express, deps: Deps) {
  const { authenticateToken, queryDB, io } = deps;
  const rows = async (sql: string, params: any[] = []) => {
    const r = await queryDB(sql, params);
    return Array.isArray(r) ? r : [];
  };

  ensureAssistantSupportSchema(queryDB).catch((err) => console.warn("⚠️ Assistant support tables:", err?.message || err));

  const me = async (req: any) => {
    if (!req.user || req.user.onb) return null;
    const r = (await rows("SELECT id, name, role, can_use_ai_assistant, can_handle_assistant_support FROM users WHERE id = ?", [req.user.id]))[0];
    if (!r) return null;
    const isSuper = r.role === "superadmin";
    return {
      id: Number(r.id),
      name: String(r.name || ""),
      isSuper,
      isAgent: isSuper || !!Number(r.can_handle_assistant_support || 0),
      canUse: isSuper || Number(r.can_use_ai_assistant ?? 1) !== 0
    };
  };

  // Superadmins and switched-on accounts of this group (users is group-scoped).
  const agents = async () =>
    (await rows("SELECT id, name, role FROM users WHERE role = 'superadmin' OR can_handle_assistant_support = 1 ORDER BY name"))
      .filter((u: any) => u.role === "superadmin" || u.role === "admin" || u.role === "user")
      .map((u: any) => ({ id: Number(u.id), name: String(u.name), role: String(u.role) }));

  const loadSession = async (id: number) =>
    (await rows(
      `SELECT s.*, u.name AS user_name, a.name AS agent_name
         FROM assistant_support_sessions s
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN users a ON a.id = s.agent_id
        WHERE s.id = ? AND s.group_id = ?`,
      [id, activeGroupId()]
    ))[0] || null;

  const messagesOf = (id: number) =>
    rows(
      `SELECT m.id, m.session_id, m.sender_id, m.kind, m.body, m.created_at, u.name AS sender_name
         FROM assistant_support_messages m LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.session_id = ? ORDER BY m.id`,
      [id]
    );

  const shape = (s: any) => ({
    id: Number(s.id),
    user_id: Number(s.user_id),
    user_name: s.user_name || null,
    agent_id: s.agent_id != null ? Number(s.agent_id) : null,
    agent_name: s.agent_name || null,
    status: String(s.status),
    topic: s.topic || null,
    created_at: s.created_at,
    accepted_at: s.accepted_at,
    closed_at: s.closed_at,
    last_message_at: s.last_message_at
  });

  const emit = (userIds: (number | null | undefined)[], payload: any) => {
    for (const id of new Set(userIds.filter((x): x is number => !!x))) io.to(`user:${id}`).emit("assistant_support", payload);
  };

  const addMessage = async (sessionId: number, senderId: number | null, kind: "user" | "agent" | "system", body: string) => {
    const r: any = await queryDB("INSERT INTO assistant_support_messages (session_id, sender_id, kind, body) VALUES (?, ?, ?, ?)", [sessionId, senderId, kind, body]);
    await queryDB("UPDATE assistant_support_sessions SET last_message_at = NOW() WHERE id = ?", [sessionId]);
    const m = (await messagesOf(sessionId)).find((x: any) => Number(x.id) === Number(r?.insertId)) || null;
    return m;
  };

  // Everyone who should see a change to this session live.
  const audience = async (s: any) => {
    const ids: number[] = [Number(s.user_id)];
    if (s.agent_id) ids.push(Number(s.agent_id));
    // A waiting chat is in every agent's queue.
    if (s.status === "waiting") for (const a of await agents()) ids.push(a.id);
    return ids;
  };

  const broadcast = async (sessionId: number, extra: any = {}) => {
    const s = await loadSession(sessionId);
    if (!s) return;
    emit(await audience(s), { session: shape(s), ...extra });
    // Queues change for every agent when a chat is taken, moved or closed.
    emit((await agents()).map((a) => a.id), { queue_changed: true });
  };

  const canSee = (who: any, s: any) => who.isAgent || Number(s.user_id) === who.id;

  // --- the person asking -----------------------------------------------------

  app.get("/api/assistant/support/access", authenticateToken, async (req: any, res: any) => {
    const who = await me(req);
    if (!who || !who.canUse) return res.status(403).json({ error: "AI Assistant isn't turned on for your account." });
    let waiting = 0;
    if (who.isAgent) {
      waiting = Number((await rows("SELECT COUNT(*) AS n FROM assistant_support_sessions WHERE group_id = ? AND status = 'waiting'", [activeGroupId()]))[0]?.n || 0);
    }
    res.json({ is_agent: who.isAgent, waiting });
  });

  app.post("/api/assistant/support/request", authenticateToken, async (req: any, res: any) => {
    try {
      const who = await me(req);
      if (!who || !who.canUse) return res.status(403).json({ error: "AI Assistant isn't turned on for your account." });
      const open = (await rows(
        `SELECT id FROM assistant_support_sessions WHERE group_id = ? AND user_id = ? AND status IN ('waiting','active') ORDER BY id DESC LIMIT 1`,
        [activeGroupId(), who.id]
      ))[0];
      if (open) {
        const s = await loadSession(Number(open.id));
        return res.json({ session: shape(s), messages: await messagesOf(Number(open.id)) });
      }
      const topic = String(req.body?.topic || "").trim().slice(0, 300) || null;
      const r: any = await queryDB(
        "INSERT INTO assistant_support_sessions (group_id, company_id, user_id, status, topic) VALUES (?, ?, ?, 'waiting', ?)",
        [activeGroupId(), activeCompanyId(), who.id, topic]
      );
      const id = Number(r?.insertId);
      // What they were asking the bot, so the agent doesn't start from zero.
      const context = Array.isArray(req.body?.context) ? req.body.context.slice(-6) : [];
      const recap = context
        .filter((m: any) => m && typeof m.text === "string" && m.text.trim())
        .map((m: any) => `${m.role === "user" ? "👤" : "🤖"} ${String(m.text).replace(/\s+/g, " ").slice(0, 200)}`)
        .join("\n");
      await addMessage(id, null, "system", `${who.name} একজন মানুষের সাথে কথা বলতে চেয়েছেন।${topic ? `\nবিষয়: ${topic}` : ""}${recap ? `\n\nAssistant-এর সাথে শেষ কথা:\n${recap}` : ""}`);
      for (const a of await agents()) {
        if (a.id === who.id) continue;
        void createAlert(queryDB, {
          userId: a.id,
          type: "assistant_support",
          title: "Live support request",
          message: `${who.name} wants to talk to someone${topic ? `: ${topic}` : ""}.`,
          relatedType: "assistant_support",
          relatedId: id
        });
      }
      await broadcast(id);
      const s = await loadSession(id);
      res.json({ session: shape(s), messages: await messagesOf(id) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The person's own open conversation (to restore the panel after a reload).
  app.get("/api/assistant/support/mine", authenticateToken, async (req: any, res: any) => {
    try {
      const who = await me(req);
      if (!who || !who.canUse) return res.status(403).json({ error: "AI Assistant isn't turned on for your account." });
      const open = (await rows(
        `SELECT id FROM assistant_support_sessions WHERE group_id = ? AND user_id = ? AND status IN ('waiting','active') ORDER BY id DESC LIMIT 1`,
        [activeGroupId(), who.id]
      ))[0];
      if (!open) return res.json({ session: null, messages: [] });
      res.json({ session: shape(await loadSession(Number(open.id))), messages: await messagesOf(Number(open.id)) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/assistant/support/sessions/:id", authenticateToken, async (req: any, res: any) => {
    try {
      const who = await me(req);
      if (!who) return res.status(403).json({ error: "Not allowed." });
      const s = await loadSession(Number(req.params.id));
      if (!s || !canSee(who, s)) return res.status(404).json({ error: "Conversation not found." });
      res.json({ session: shape(s), messages: await messagesOf(Number(s.id)) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/assistant/support/sessions/:id/messages", authenticateToken, async (req: any, res: any) => {
    try {
      const who = await me(req);
      if (!who) return res.status(403).json({ error: "Not allowed." });
      const s = await loadSession(Number(req.params.id));
      if (!s || !canSee(who, s)) return res.status(404).json({ error: "Conversation not found." });
      if (!OPEN.includes(s.status)) return res.status(409).json({ error: "This conversation has ended." });
      const isOwner = Number(s.user_id) === who.id;
      const isAssigned = s.agent_id != null && Number(s.agent_id) === who.id;
      if (!isOwner && !isAssigned) return res.status(403).json({ error: s.status === "waiting" ? "Accept the chat first." : "This chat is with another agent." });
      const body = String(req.body?.body || "").trim().slice(0, 2000);
      if (!body) return res.status(400).json({ error: "Message is empty." });
      const m = await addMessage(Number(s.id), who.id, isOwner ? "user" : "agent", body);
      emit(await audience(s), { session_id: Number(s.id), message: m });
      res.json({ message: m });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/assistant/support/sessions/:id/close", authenticateToken, async (req: any, res: any) => {
    try {
      const who = await me(req);
      if (!who) return res.status(403).json({ error: "Not allowed." });
      const s = await loadSession(Number(req.params.id));
      if (!s || !canSee(who, s)) return res.status(404).json({ error: "Conversation not found." });
      const isOwner = Number(s.user_id) === who.id;
      const isAssigned = s.agent_id != null && Number(s.agent_id) === who.id;
      if (!isOwner && !isAssigned && !who.isSuper) return res.status(403).json({ error: "Only the person or the agent handling it can end this chat." });
      if (!OPEN.includes(s.status)) return res.json({ session: shape(s) });
      await queryDB("UPDATE assistant_support_sessions SET status = 'closed', closed_at = NOW(), closed_by = ? WHERE id = ?", [who.id, s.id]);
      const m = await addMessage(Number(s.id), null, "system", `${who.name} কথোপকথন শেষ করেছেন।`);
      emit(await audience(s), { session_id: Number(s.id), message: m });
      await broadcast(Number(s.id));
      res.json({ session: shape(await loadSession(Number(s.id))) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- agents ----------------------------------------------------------------

  const requireAgent = async (req: any, res: any, next: any) => {
    const who = await me(req);
    if (!who || !who.isAgent) return res.status(403).json({ error: "Assistant live support isn't turned on for your account." });
    req.agent = who;
    next();
  };

  // Waiting chats, the agent's own, and (Superadmin) everyone else's open ones.
  app.get("/api/assistant/support/queue", authenticateToken, requireAgent, async (req: any, res: any) => {
    try {
      const list = await rows(
        `SELECT s.*, u.name AS user_name, a.name AS agent_name,
                (SELECT m.body FROM assistant_support_messages m WHERE m.session_id = s.id ORDER BY m.id DESC LIMIT 1) AS last_body
           FROM assistant_support_sessions s
           LEFT JOIN users u ON u.id = s.user_id
           LEFT JOIN users a ON a.id = s.agent_id
          WHERE s.group_id = ? AND (s.status IN ('waiting','active') OR (s.agent_id = ? AND s.closed_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)))
          ORDER BY FIELD(s.status, 'waiting', 'active', 'closed'), s.last_message_at DESC
          LIMIT 100`,
        [activeGroupId(), req.agent.id]
      );
      const visible = list.filter((s: any) => s.status !== "active" || req.agent.isSuper || Number(s.agent_id) === req.agent.id);
      res.json(visible.map((s: any) => ({ ...shape(s), last_body: s.last_body ? String(s.last_body).slice(0, 140) : null })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/assistant/support/agents", authenticateToken, requireAgent, async (req: any, res: any) => {
    res.json((await agents()).filter((a) => a.id !== req.agent.id));
  });

  app.post("/api/assistant/support/sessions/:id/accept", authenticateToken, requireAgent, async (req: any, res: any) => {
    try {
      const s = await loadSession(Number(req.params.id));
      if (!s) return res.status(404).json({ error: "Conversation not found." });
      if (Number(s.user_id) === req.agent.id) return res.status(400).json({ error: "You can't answer your own request." });
      if (s.status !== "waiting") return res.status(409).json({ error: s.status === "active" ? `${s.agent_name || "Another agent"} is already handling this chat.` : "This conversation has ended." });
      // Only one agent wins if two press Accept together.
      const r: any = await queryDB("UPDATE assistant_support_sessions SET status = 'active', agent_id = ?, accepted_at = NOW() WHERE id = ? AND status = 'waiting'", [req.agent.id, s.id]);
      if (r && r.affectedRows === 0) return res.status(409).json({ error: "Another agent just took this chat." });
      const m = await addMessage(Number(s.id), null, "system", `${req.agent.name} কথোপকথনে যোগ দিয়েছেন।`);
      emit([Number(s.user_id), req.agent.id], { session_id: Number(s.id), message: m });
      await broadcast(Number(s.id));
      res.json({ session: shape(await loadSession(Number(s.id))), messages: await messagesOf(Number(s.id)) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Hand an active chat to another agent (the one handling it, or a Superadmin).
  app.post("/api/assistant/support/sessions/:id/transfer", authenticateToken, requireAgent, async (req: any, res: any) => {
    try {
      const s = await loadSession(Number(req.params.id));
      if (!s) return res.status(404).json({ error: "Conversation not found." });
      if (!OPEN.includes(s.status)) return res.status(409).json({ error: "This conversation has ended." });
      const handling = s.agent_id != null && Number(s.agent_id) === req.agent.id;
      if (!handling && !req.agent.isSuper) return res.status(403).json({ error: "Only the agent handling this chat can transfer it." });
      const toId = Number(req.body?.to_user_id);
      const target = (await agents()).find((a) => a.id === toId);
      if (!target) return res.status(400).json({ error: "Pick someone who handles Assistant live support." });
      if (target.id === Number(s.user_id)) return res.status(400).json({ error: "You can't transfer a chat to the person who asked." });
      if (s.agent_id != null && Number(s.agent_id) === target.id) return res.status(400).json({ error: `${target.name} is already handling this chat.` });
      const fromId = s.agent_id != null ? Number(s.agent_id) : null;
      await queryDB("UPDATE assistant_support_sessions SET status = 'active', agent_id = ?, accepted_at = COALESCE(accepted_at, NOW()) WHERE id = ?", [target.id, s.id]);
      const note = String(req.body?.note || "").trim().slice(0, 300);
      const m = await addMessage(Number(s.id), null, "system", `${req.agent.name} কথোপকথনটি ${target.name}-এর কাছে পাঠিয়েছেন।${note ? `\nনোট: ${note}` : ""}`);
      emit([Number(s.user_id), fromId, target.id, req.agent.id], { session_id: Number(s.id), message: m });
      void createAlert(queryDB, {
        userId: target.id,
        type: "assistant_support",
        title: "Live support chat transferred to you",
        message: `${req.agent.name} transferred ${s.user_name || "a"}'s chat to you.${note ? ` Note: ${note}` : ""}`,
        relatedType: "assistant_support",
        relatedId: Number(s.id)
      });
      await broadcast(Number(s.id));
      res.json({ session: shape(await loadSession(Number(s.id))) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
