/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Chat audio / video calls (one-to-one, from a Direct chat) — WebRTC.
//
// The media goes phone-to-phone (or through a TURN relay); this server only
// passes the call along on the same Socket.IO connection Chat already uses
// (setupChatSocket in ChatRoutes.ts authenticates it):
//
//   call:invite  {roomId, kind}      caller -> server -> callee's devices: call:incoming
//   call:accept  {callId}            callee -> caller: call:accepted (other devices: call:taken)
//   call:decline {callId}            callee -> caller: call:ended {reason:'declined'}
//   call:signal  {callId, data}      offer / answer / ICE candidates, to the other side
//   call:end     {callId}            either side -> the other: call:ended
//
// Unanswered after RING_MS it ends as a missed call; a side that drops off
// (last socket gone) ends it too. Every call leaves a line in the chat
// ("📞 Audio call · 3:12" / "📞 Missed video call"), which also pushes the
// usual chat notification — so a missed call reaches a phone with the app
// closed.
//
// Only accounts with Calls access (users.can_use_calls, Module Access ->
// "Also allow Audio / Video Calls"; a Superadmin always) can call or be
// called.
//
// ICE servers (GET /api/calls/ice-servers): Google's public STUN always, plus
// TURN when the server is given one in .env —
//   CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN  (Cloudflare Calls TURN), or
//   TURN_URLS (comma-separated) + TURN_USERNAME + TURN_CREDENTIAL  (any TURN, e.g. coturn).
// Without TURN most calls still connect; ones behind strict mobile / office
// networks may not.

import type { Express } from "express";
import type { Server as SocketIOServer, Socket } from "socket.io";
import crypto from "crypto";
import { insertChatMessage, notifyNewMessage } from "./ChatRoutes";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

const RING_MS = 45 * 1000;
const STUN = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

// Calls access per account, cached briefly.
const accessCache = new Map<number, { ok: boolean; name: string; at: number }>();
async function callAccess(queryDB: QueryDB, userId: number) {
  const hit = accessCache.get(userId);
  if (hit && Date.now() - hit.at < 30 * 1000) return hit;
  const rows: any[] = (await queryDB("SELECT id, name, role, can_use_calls FROM users WHERE id = ?", [userId]).catch(() => [])) || [];
  const u = rows.find((r) => Number(r.id) === userId);
  const v = { ok: !!u && (u.role === "superadmin" || !!Number(u.can_use_calls)), name: u?.name || "Someone", at: Date.now() };
  accessCache.set(userId, v);
  return v;
}

let cfCache: { servers: any[]; until: number } | null = null;
async function turnServers(): Promise<any[]> {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const token = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (keyId && token) {
    if (cfCache && cfCache.until > Date.now()) return cfCache.servers;
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 })
      });
      const data: any = await r.json();
      const ice = data?.iceServers;
      const servers = Array.isArray(ice) ? ice : ice ? [ice] : [];
      if (servers.length) {
        cfCache = { servers, until: Date.now() + 12 * 3600 * 1000 };
        return servers;
      }
      console.warn("⚠️ Cloudflare TURN gave no ICE servers: " + JSON.stringify(data).slice(0, 200));
    } catch (err: any) {
      console.warn("⚠️ Could not get Cloudflare TURN credentials: " + err.message);
    }
    return [];
  }
  const urls = String(process.env.TURN_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!urls.length) return [];
  return [{ urls, username: process.env.TURN_USERNAME || "", credential: process.env.TURN_CREDENTIAL || "" }];
}

export function registerCallRoutes(app: Express, deps: { authenticateToken: any; queryDB: QueryDB }) {
  const { authenticateToken, queryDB } = deps;
  app.get("/api/calls/ice-servers", authenticateToken, async (req: any, res) => {
    try {
      if (!(await callAccess(queryDB, Number(req.user.id))).ok) return res.status(403).json({ error: "Calls aren't turned on for your account." });
      const turn = await turnServers();
      res.json({ iceServers: [...STUN, ...turn], turn: turn.length > 0 });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
}

interface Call {
  id: string;
  roomId: number;
  kind: "audio" | "video";
  callerId: number;
  callerName: string;
  callerSocket: string;
  calleeId: number;
  calleeName: string;
  calleeSocket: string | null;
  state: "ringing" | "active";
  acceptedAt: number | null;
  ringTimer: NodeJS.Timeout | null;
}

export function setupCallSocket(io: SocketIOServer, deps: { queryDB: QueryDB }) {
  const { queryDB } = deps;
  const calls = new Map<string, Call>();
  const busy = new Map<number, string>(); // userId -> callId

  const duration = (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  };

  // The line the call leaves in the chat (and its push notification).
  const logCall = async (c: Pick<Call, "roomId" | "callerId" | "kind">, text: string) => {
    try {
      const message = await insertChatMessage(queryDB, { roomId: c.roomId, senderId: c.callerId, messageType: "text", content: text });
      io.to(`room:${c.roomId}`).emit("receive_message", message);
      void notifyNewMessage(queryDB, message);
    } catch {
      // The call itself already happened; the log line is best-effort.
    }
  };
  const label = (kind: string) => (kind === "video" ? "video call" : "audio call");

  const finish = (c: Call, reason: string, by: number | null) => {
    if (!calls.has(c.id)) return;
    calls.delete(c.id);
    if (c.ringTimer) clearTimeout(c.ringTimer);
    if (busy.get(c.callerId) === c.id) busy.delete(c.callerId);
    if (busy.get(c.calleeId) === c.id) busy.delete(c.calleeId);
    const payload = { callId: c.id, reason };
    // Tell both sides (every device of the callee while it was still ringing).
    io.to(c.callerSocket).emit("call:ended", payload);
    if (c.calleeSocket) io.to(c.calleeSocket).emit("call:ended", payload);
    else io.to(`user:${c.calleeId}`).emit("call:ended", payload);
    if (c.state === "active" && c.acceptedAt) void logCall(c, `📞 ${c.kind === "video" ? "Video" : "Audio"} call · ${duration(Date.now() - c.acceptedAt)}`);
    else if (reason === "declined") void logCall(c, `📞 ${c.calleeName} declined the ${label(c.kind)}`);
    else void logCall(c, `📞 Missed ${label(c.kind)}`);
    void by;
  };

  io.on("connection", (socket: Socket) => {
    const me = Number((socket.data as any)?.user?.id);
    if (!me) return;

    socket.on("call:invite", async (data: { roomId: number; kind: string }, ack?: (r: any) => void) => {
      const reply = (r: any) => ack && ack(r);
      try {
        const roomId = Number(data?.roomId);
        const kind: "audio" | "video" = data?.kind === "video" ? "video" : "audio";
        const mine = await callAccess(queryDB, me);
        if (!mine.ok) return reply({ ok: false, error: "Calls aren't turned on for your account." });
        const rooms: any[] = (await queryDB("SELECT id, type FROM chat_rooms WHERE id = ?", [roomId])) || [];
        const room = rooms.find((r) => Number(r.id) === roomId);
        if (!room || room.type !== "direct") return reply({ ok: false, error: "Calls work from a one-to-one chat." });
        const members: any[] = (await queryDB("SELECT user_id FROM chat_room_members WHERE room_id = ?", [roomId])) || [];
        const ids = members.map((m) => Number(m.user_id));
        if (!ids.includes(me)) return reply({ ok: false, error: "You're not in this chat." });
        const peerId = ids.find((id) => id !== me);
        if (!peerId) return reply({ ok: false, error: "Nobody else is in this chat." });
        const peer = await callAccess(queryDB, peerId);
        if (!peer.ok) return reply({ ok: false, error: `${peer.name} can't receive calls yet — Calls aren't turned on for them.` });
        if (busy.has(me)) return reply({ ok: false, error: "You're already in a call." });
        if (busy.has(peerId)) return reply({ ok: false, error: `${peer.name} is on another call.` });
        const peerSockets = await io.in(`user:${peerId}`).fetchSockets();
        if (peerSockets.length === 0) {
          void logCall({ roomId, callerId: me, kind }, `📞 Missed ${label(kind)}`);
          return reply({ ok: false, error: `${peer.name} isn't online right now — they'll see a missed call.` });
        }
        const call: Call = {
          id: crypto.randomUUID(),
          roomId,
          kind,
          callerId: me,
          callerName: mine.name,
          callerSocket: socket.id,
          calleeId: peerId,
          calleeName: peer.name,
          calleeSocket: null,
          state: "ringing",
          acceptedAt: null,
          ringTimer: null
        };
        call.ringTimer = setTimeout(() => finish(call, "no-answer", null), RING_MS);
        calls.set(call.id, call);
        busy.set(me, call.id);
        busy.set(peerId, call.id);
        io.to(`user:${peerId}`).emit("call:incoming", { callId: call.id, roomId, kind, from: { id: me, name: mine.name } });
        reply({ ok: true, callId: call.id, peer: { id: peerId, name: peer.name } });
      } catch (err: any) {
        reply({ ok: false, error: err?.message || "Couldn't start the call." });
      }
    });

    socket.on("call:accept", (data: { callId: string }, ack?: (r: any) => void) => {
      const c = calls.get(String(data?.callId));
      if (!c || c.calleeId !== me || c.state !== "ringing") return ack && ack({ ok: false, error: "This call has ended." });
      if (c.ringTimer) clearTimeout(c.ringTimer);
      c.ringTimer = null;
      c.state = "active";
      c.calleeSocket = socket.id;
      c.acceptedAt = Date.now();
      io.to(c.callerSocket).emit("call:accepted", { callId: c.id });
      // The callee's other devices stop ringing.
      socket.to(`user:${me}`).emit("call:taken", { callId: c.id });
      ack && ack({ ok: true });
    });

    socket.on("call:decline", (data: { callId: string }) => {
      const c = calls.get(String(data?.callId));
      if (!c || c.calleeId !== me || c.state !== "ringing") return;
      finish(c, "declined", me);
    });

    socket.on("call:signal", (data: { callId: string; data: any }) => {
      const c = calls.get(String(data?.callId));
      if (!c || c.state !== "active") return;
      const to = socket.id === c.callerSocket ? c.calleeSocket : socket.id === c.calleeSocket ? c.callerSocket : null;
      if (to) io.to(to).emit("call:signal", { callId: c.id, data: data.data });
    });

    socket.on("call:end", (data: { callId: string }) => {
      const c = calls.get(String(data?.callId));
      if (!c) return;
      if (socket.id !== c.callerSocket && socket.id !== c.calleeSocket && !(c.state === "ringing" && c.calleeId === me)) return;
      finish(c, c.state === "ringing" && socket.id === c.callerSocket ? "cancelled" : "ended", me);
    });

    socket.on("disconnect", () => {
      for (const c of Array.from(calls.values())) {
        if (c.callerSocket === socket.id || c.calleeSocket === socket.id) finish(c, "disconnected", me);
      }
    });
  });
}
