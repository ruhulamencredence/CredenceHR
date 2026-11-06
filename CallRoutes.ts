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
//   call:rejoin  {callId}            a side whose connection dropped is back (new socket)
//                                    -> the other side: call:peer-back (call:peer-away when it dropped)
//
// Unanswered after RING_MS it ends as a missed call. A side whose connection
// drops (phone switching Wi-Fi <-> mobile data, a short network gap) gets
// RECONNECT_MS to come back with call:rejoin before the call ends as
// "dropped"; the media itself reconnects with an ICE restart (CallLayer.tsx). Every call leaves a line in the chat
// ("📞 Audio call · 3:12" / "📞 Missed video call"), which also pushes the
// usual chat notification — so a missed call reaches a phone with the app
// closed.
//
// Only accounts with Calls access (users.can_use_calls, Module Access ->
// "Also allow Audio / Video Calls"; a Superadmin always) can call or be
// called.
//
// A phone with the app closed or in the background: the callee's Android
// devices also get a high-priority "call_incoming" push, which shows the
// phone's own incoming-call screen (IncomingCall.java). Accept opens the app;
// when its socket connects, the ringing call is announced to it again
// (announce below) and the page answers it. Decline posts the one-call key
// from the push to POST /api/calls/push-decline (no sign-in needed — the key
// only ever went to the callee's own devices). "call_cancel" takes the screen
// away when the call ends or is answered elsewhere.
//
// ICE servers (GET /api/calls/ice-servers): Google's public STUN always, plus
// TURN when the server is given one in .env —
//   CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN  (Cloudflare Calls TURN), or
//   TURN_URLS (comma-separated) + TURN_USERNAME + TURN_CREDENTIAL  (any TURN, e.g. coturn).
// Without TURN, calls on the same Wi-Fi usually connect, but phones on mobile
// data (carrier-grade NAT) or behind strict office firewalls can't reach each
// other and the call stays on "Connecting…" until it gives up — set TURN.

import type { Express } from "express";
import type { Server as SocketIOServer, Socket } from "socket.io";
import crypto from "crypto";
import { insertChatMessage, notifyNewMessage } from "./ChatRoutes";
import { currentAppMask } from "./AppAccess";
import { sendSilentPushToUserIds } from "./PushNotificationService";
import { inGroupCall } from "./GroupCallRoutes";

// Set by setupCallSocket: this account is in a one-to-one call on this worker
// (group calls, GroupCallRoutes.ts, refuse a join then).
export let inOneToOneCall: (userId: number) => boolean = () => false;

// Set by setupCallSocket: Decline tapped on the phone's call screen.
let pushDecline: ((callId: string, key: string) => Promise<boolean>) | null = null;

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

const RING_MS = 45 * 1000;
// How long a side may be gone (socket dropped) before the call ends.
const RECONNECT_MS = 30 * 1000;
const STUN = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

// Calls access per account, cached briefly.
const accessCache = new Map<number, { ok: boolean; name: string; at: number }>();
export async function callAccess(queryDB: QueryDB, userId: number) {
  // A mobile-app request with its own narrower access skips the shared cache (AppAccess.ts).
  const app = !!currentAppMask();
  const hit = app ? undefined : accessCache.get(userId);
  if (hit && Date.now() - hit.at < 30 * 1000) return hit;
  const rows: any[] = (await queryDB("SELECT id, name, role, can_use_calls, can_use_chat FROM users WHERE id = ?", [userId]).catch(() => [])) || [];
  const u = rows.find((r) => Number(r.id) === userId);
  // Calls start from a one-to-one Chat, so they need Chat too.
  const v = {
    ok: !!u && (u.role === "superadmin" || (!!Number(u.can_use_calls) && Number(u.can_use_chat ?? 1) !== 0)),
    name: u?.name || "Someone",
    at: Date.now()
  };
  if (!app) accessCache.set(userId, v);
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
  if (!(process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_API_TOKEN) && !String(process.env.TURN_URLS || "").trim()) {
    console.warn(
      "⚠️ Calls: no TURN relay set (CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_API_TOKEN or TURN_URLS in .env) — calls between phones on mobile data or strict networks will stay on \"Connecting…\" and fail."
    );
  }
  // Decline from the phone's incoming-call notification, the app not open.
  // The key was in that call's push only (see the top of this file).
  app.post("/api/calls/push-decline", async (req: any, res) => {
    const callId = String(req.body?.callId || "").slice(0, 64);
    const key = String(req.body?.key || "").slice(0, 128);
    if (!callId || !key || !pushDecline) return res.status(400).json({ error: "Missing call." });
    try {
      res.json({ ok: await pushDecline(callId, key) });
    } catch {
      res.json({ ok: false });
    }
  });

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
  // Set while a side's socket has dropped and it may still come back.
  awayTimer: NodeJS.Timeout | null;
  // The callee's phones were rung by push (IncomingCall.java); pushKey lets
  // Decline on that screen end the call without signing in.
  pushed: boolean;
  pushKey: string;
}

export function setupCallSocket(io: SocketIOServer, deps: { queryDB: QueryDB }) {
  const { queryDB } = deps;
  const calls = new Map<string, Call>();
  const busy = new Map<number, string>(); // userId -> callId
  inOneToOneCall = (userId: number) => busy.has(userId);

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
    if (c.awayTimer) clearTimeout(c.awayTimer);
    if (busy.get(c.callerId) === c.id) busy.delete(c.callerId);
    if (busy.get(c.calleeId) === c.id) busy.delete(c.calleeId);
    // Take the phone's incoming-call screen away (still ringing there).
    if (c.pushed) void sendSilentPushToUserIds(queryDB, [c.calleeId], { type: "call_cancel", callId: c.id }, RING_MS);
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

  // One call event, for a call this process holds. Returns the reply for
  // call:accept (null = no such call here).
  const handle = (type: string, callId: string, me: number, socketId: string, data: any): any => {
    const c = calls.get(callId);
    if (type === "disconnect") {
      for (const x of Array.from(calls.values())) {
        const caller = x.callerSocket === socketId;
        if (!caller && x.calleeSocket !== socketId) continue;
        // Give the side a moment to come back (call:rejoin) instead of
        // ending the call on the first network blip.
        const other = caller ? x.calleeSocket : x.callerSocket;
        if (other) io.to(other).emit("call:peer-away", { callId: x.id });
        if (x.awayTimer) clearTimeout(x.awayTimer);
        x.awayTimer = setTimeout(() => finish(x, "disconnected", me), RECONNECT_MS);
      }
      return null;
    }
    if (type === "announce") {
      // An account's socket just connected (e.g. the app opened from the
      // incoming-call screen): a call still ringing for it rings there too.
      for (const x of Array.from(calls.values())) {
        if (x.calleeId === me && x.state === "ringing") io.to(socketId).emit("call:incoming", { callId: x.id, roomId: x.roomId, kind: x.kind, from: { id: x.callerId, name: x.callerName } });
      }
      return null;
    }
    if (!c) return null;
    if (type === "pushdecline") {
      if (c.state !== "ringing" || !c.pushKey || data !== c.pushKey) return { ok: false };
      finish(c, "declined", c.calleeId);
      return { ok: true };
    }
    if (type === "rejoin") {
      // Only the same account, for its own side of the call.
      let side: "caller" | "callee" | null = null;
      if (c.callerId === me) side = "caller";
      else if (c.calleeId === me && c.state === "active") side = "callee";
      if (!side) return { ok: false, error: "This call has ended." };
      if (side === "caller") c.callerSocket = socketId;
      else c.calleeSocket = socketId;
      if (c.awayTimer) clearTimeout(c.awayTimer);
      c.awayTimer = null;
      const other = side === "caller" ? c.calleeSocket : c.callerSocket;
      if (other) io.to(other).emit("call:peer-back", { callId: c.id });
      return { ok: true, state: c.state, role: side };
    }
    if (type === "accept") {
      if (c.calleeId !== me || c.state !== "ringing") return { ok: false, error: "This call has ended." };
      if (c.ringTimer) clearTimeout(c.ringTimer);
      c.ringTimer = null;
      c.state = "active";
      c.calleeSocket = socketId;
      c.acceptedAt = Date.now();
      io.to(c.callerSocket).emit("call:accepted", { callId: c.id });
      // The callee's other devices stop ringing.
      io.to(`user:${me}`).except(socketId).emit("call:taken", { callId: c.id });
      // Other phones of the callee may still show the call screen.
      if (c.pushed) void sendSilentPushToUserIds(queryDB, [c.calleeId], { type: "call_cancel", callId: c.id }, RING_MS);
      return { ok: true };
    }
    if (type === "decline") {
      if (c.calleeId === me && c.state === "ringing") finish(c, "declined", me);
      return { ok: true };
    }
    if (type === "signal") {
      if (c.state !== "active") return { ok: true };
      const to = socketId === c.callerSocket ? c.calleeSocket : socketId === c.calleeSocket ? c.callerSocket : null;
      if (to) io.to(to).emit("call:signal", { callId: c.id, data });
      return { ok: true };
    }
    if (type === "end") {
      if (socketId !== c.callerSocket && socketId !== c.calleeSocket && !(c.state === "ringing" && c.calleeId === me)) return { ok: true };
      finish(c, c.state === "ringing" && socketId === c.callerSocket ? "cancelled" : "ended", me);
      return { ok: true };
    }
    return null;
  };

  // Several workers share events only through the Redis adapter
  // (server.ts, REDIS_URL); with the default in-memory adapter there is no
  // other process to ask.
  const clustered = () => io.of("/").adapter.constructor.name !== "Adapter";

  // Ask every other worker; resolves with their answers (none on error/timeout).
  const askOthers = (ev: string, payload: any): Promise<any[]> =>
    new Promise((resolve) => {
      try {
        (io as any).serverSideEmit(ev, payload, (err: any, answers: any[]) => resolve(err ? [] : answers || []));
      } catch {
        resolve([]);
      }
    });

  const handleOrRelay = async (type: string, callId: string, me: number, socketId: string, data: any): Promise<any> => {
    if (calls.has(callId) || !clustered()) return handle(type, callId, me, socketId, data);
    try {
      const answers = await askOthers("call:relay", { type, callId, me, socketId, data });
      return answers.find((a) => a) || null;
    } catch {
      return null;
    }
  };
  pushDecline = async (callId: string, key: string) => !!(await handleOrRelay("pushdecline", callId, 0, "", key))?.ok;
  (io as any).on("call:relay", (p: any, done?: (r: any) => void) => {
    const r = p && (p.type === "disconnect" || p.type === "announce" || calls.has(String(p.callId))) ? handle(String(p.type), String(p.callId), Number(p.me), String(p.socketId), p.data) : null;
    if (typeof done === "function") done(r);
  });

  // Whether another worker has this account in a call.
  const busyElsewhere = async (userId: number): Promise<boolean> => {
    if (!clustered()) return false;
    try {
      return (await askOthers("call:busy", userId)).some(Boolean);
    } catch {
      return false;
    }
  };
  (io as any).on("call:busy", (userId: any, done?: (r: boolean) => void) => {
    if (typeof done === "function") done(busy.has(Number(userId)));
  });

  io.on("connection", (socket: Socket) => {
    const me = Number((socket.data as any)?.user?.id);
    if (!me) return;
    // A call ringing for this account (e.g. it just opened the app from the
    // phone's call screen) rings on this socket too — here and on any other worker.
    if (Array.from(calls.values()).some((x) => x.calleeId === me && x.state === "ringing")) handle("announce", "", me, socket.id, null);
    if (clustered()) (io as any).serverSideEmit("call:relay", { type: "announce", callId: "", me, socketId: socket.id, data: null });

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
        if (busy.has(me) || inGroupCall(me) || (await busyElsewhere(me))) return reply({ ok: false, error: "You're already in a call." });
        if (busy.has(peerId) || inGroupCall(peerId) || (await busyElsewhere(peerId))) return reply({ ok: false, error: `${peer.name} is on another call.` });
        const peerSockets = await io.in(`user:${peerId}`).fetchSockets();
        // Ring the callee's phones by push too: with the app closed or in the
        // background there is no socket (or a sleeping one). The phone shows
        // its call screen only when the app isn't on screen.
        const callId = crypto.randomUUID();
        const pushKey = crypto.randomBytes(24).toString("hex");
        const pushedTo = await sendSilentPushToUserIds(
          queryDB,
          [peerId],
          { type: "call_incoming", callId, roomId: String(roomId), kind, fromId: String(me), fromName: mine.name, declineKey: pushKey },
          RING_MS
        );
        if (peerSockets.length === 0 && pushedTo === 0) {
          void logCall({ roomId, callerId: me, kind }, `📞 Missed ${label(kind)}`);
          return reply({ ok: false, error: `${peer.name} isn't online right now — they'll see a missed call.` });
        }
        const call: Call = {
          id: callId,
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
          ringTimer: null,
          awayTimer: null,
          pushed: pushedTo > 0,
          pushKey: pushedTo > 0 ? pushKey : ""
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

    // accept / decline / signal / end / disconnect: handled where the call
    // lives (the caller's process). Under PM2 cluster mode the other side
    // may be connected to another worker — then it is passed on to the
    // worker that has the call (relay below), which answers the same way.
    socket.on("call:accept", async (data: { callId: string }, ack?: (r: any) => void) => {
      const r = await handleOrRelay("accept", String(data?.callId), me, socket.id, null);
      ack && ack(r || { ok: false, error: "This call has ended." });
    });
    socket.on("call:decline", (data: { callId: string }) => void handleOrRelay("decline", String(data?.callId), me, socket.id, null));
    socket.on("call:signal", (data: { callId: string; data: any }) => void handleOrRelay("signal", String(data?.callId), me, socket.id, data?.data));
    socket.on("call:end", (data: { callId: string }) => void handleOrRelay("end", String(data?.callId), me, socket.id, null));
    // The page asks again once it is ready (it may have missed the announce
    // sent the moment its socket connected).
    socket.on("call:announce", () => {
      handle("announce", "", me, socket.id, null);
      if (clustered()) (io as any).serverSideEmit("call:relay", { type: "announce", callId: "", me, socketId: socket.id, data: null });
    });
    socket.on("call:rejoin", async (data: { callId: string }, ack?: (r: any) => void) => {
      const r = await handleOrRelay("rejoin", String(data?.callId), me, socket.id, null);
      ack && ack(r || { ok: false, error: "This call has ended." });
    });
    socket.on("disconnect", () => {
      handle("disconnect", "", me, socket.id, null);
      if (clustered()) (io as any).serverSideEmit("call:relay", { type: "disconnect", callId: "", me, socketId: socket.id, data: null });
    });
  });
}
