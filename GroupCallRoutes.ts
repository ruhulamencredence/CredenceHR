/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Chat group calls (audio / video) from a Group or Community chat — WebRTC,
// every participant connected to every other (a mesh), so it is kept to
// MAX_PARTICIPANTS. The server only passes the call along on the Chat
// socket; the media goes phone-to-phone (or through the TURN relay that
// one-to-one calls use, GET /api/calls/ice-servers).
//
//   gcall:start  {roomId, kind}          start (or, if one is on, get the running one)
//                                        -> members' devices: gcall:incoming (they ring)
//   gcall:join   {callId}                 join; the reply lists who is already in, and the
//                                        newcomer sends each of them an offer
//                                        -> the others: gcall:joined
//   gcall:signal {callId, to, data}       offer / answer / ICE to one participant (socket id)
//   gcall:leave  {callId}                 -> the others: gcall:left; the last one out ends it
//   gcall:decline {callId}                stop ringing on this account's devices
//   gcall:active {roomId}                 is a call on in this chat? (for the "Join" bar)
//   gcall:room   (server -> room)         the call in a chat started / changed / ended
//
// Who: accounts with Calls access (same switch as one-to-one calls — Module
// Access -> "Also allow Audio / Video Calls"; a Superadmin always) who are
// members of the chat. A group call leaves "📞 … started a group call" (with
// the chat's push) and, when it ends, its length in the chat.
//
// Phones with the app closed or in the background: the members' Android
// devices also get a high-priority "call_incoming" push (group: "1"), which
// rings with the phone's ringtone and shows the call screen
// (IncomingCallService.java); Accept opens the app and joins. "call_cancel"
// stops it when that member joins or declines on another device, or the call ends.
//
// Several workers (PM2 + Redis adapter): a call lives on the worker it was
// started on; the other workers pass its events there (gcall:relay), the same
// way one-to-one calls do.

import type { Server as SocketIOServer, Socket } from "socket.io";
import crypto from "crypto";
import { insertChatMessage, notifyNewMessage } from "./ChatRoutes";
import { inOneToOneCall } from "./CallRoutes";
import { sendSilentPushToUserIds } from "./PushNotificationService";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export const MAX_PARTICIPANTS = 8;
// Everyone left: the call waits this long (a dropped phone may come back).
const EMPTY_END_MS = 20 * 1000;

interface GroupCall {
  id: string;
  roomId: number;
  title: string;
  kind: "audio" | "video";
  startedBy: number;
  startedByName: string;
  startedAt: number;
  participants: Map<string, { userId: number; name: string; joinedAt: number }>; // socket id -> who
  endTimer: NodeJS.Timeout | null;
  // Members whose phones were rung by push and haven't joined / declined yet.
  rung: Set<number>;
}

const RING_MS = 45 * 1000;

// Set by setupGroupCallSocket — lets one-to-one calls (CallRoutes.ts) say
// "already in a call" for someone in a group call on this worker.
export let inGroupCall: (userId: number) => boolean = () => false;

export function setupGroupCallSocket(io: SocketIOServer, deps: { queryDB: QueryDB; callAccess: (userId: number) => Promise<{ ok: boolean; name: string }> }) {
  const { queryDB, callAccess } = deps;
  const calls = new Map<string, GroupCall>();
  inGroupCall = (userId: number) => Array.from(calls.values()).some((c) => Array.from(c.participants.values()).some((p) => p.userId === userId));

  const clock = (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  };
  const post = async (roomId: number, senderId: number, text: string, push: boolean) => {
    try {
      const message = await insertChatMessage(queryDB, { roomId, senderId, messageType: "text", content: text });
      io.to(`room:${roomId}`).emit("receive_message", message);
      if (push) void notifyNewMessage(queryDB, message);
    } catch {
      // the call itself goes on; this line is a nicety
    }
  };
  const roomState = (c: GroupCall | null, roomId: number) =>
    io.to(`room:${roomId}`).emit("gcall:room", c ? { roomId, callId: c.id, kind: c.kind, count: new Set(Array.from(c.participants.values()).map((p) => p.userId)).size } : { roomId, callId: null });

  // Their phones stop ringing (the call screen started by the push).
  const stopRingPush = (c: GroupCall, userIds: number[]) => {
    const ids = userIds.filter((id) => c.rung.delete(id));
    if (ids.length) void sendSilentPushToUserIds(queryDB, ids, { type: "call_cancel", callId: c.id }, RING_MS);
  };

  const finish = (c: GroupCall) => {
    if (!calls.has(c.id)) return;
    calls.delete(c.id);
    stopRingPush(c, Array.from(c.rung));
    if (c.endTimer) clearTimeout(c.endTimer);
    io.to(`room:${c.roomId}`).emit("gcall:ended", { callId: c.id });
    roomState(null, c.roomId);
    void post(c.roomId, c.startedBy, `📞 Group ${c.kind === "video" ? "video" : "audio"} call ended · ${clock(Date.now() - c.startedAt)}`, false);
  };

  const removeSocket = (c: GroupCall, socketId: string) => {
    const p = c.participants.get(socketId);
    if (!p) return;
    c.participants.delete(socketId);
    for (const other of c.participants.keys()) io.to(other).emit("gcall:left", { callId: c.id, socketId, userId: p.userId });
    roomState(c, c.roomId);
    if (c.participants.size === 0) {
      if (c.endTimer) clearTimeout(c.endTimer);
      c.endTimer = setTimeout(() => {
        if (c.participants.size === 0) finish(c);
      }, EMPTY_END_MS);
    }
  };

  // One event for a call this worker holds; null = not here.
  const handle = async (type: string, callId: string, me: number, socketId: string, data: any): Promise<any> => {
    if (type === "disconnect") {
      for (const c of Array.from(calls.values())) removeSocket(c, socketId);
      return null;
    }
    if (type === "find") {
      const c = Array.from(calls.values()).find((x) => x.roomId === Number(data));
      return c ? { callId: c.id, kind: c.kind, count: new Set(Array.from(c.participants.values()).map((p) => p.userId)).size } : null;
    }
    const c = calls.get(callId);
    if (!c) return null;
    if (type === "join") {
      const member = ((await queryDB("SELECT 1 FROM chat_room_members WHERE room_id = ? AND user_id = ?", [c.roomId, me])) || []).length > 0;
      if (!member) return { ok: false, error: "You're not in this group." };
      const users = new Set(Array.from(c.participants.values()).map((p) => p.userId));
      // The same account on a new connection replaces its old one.
      for (const [sid, p] of Array.from(c.participants.entries())) if (p.userId === me && sid !== socketId) removeSocket(c, sid);
      if (!users.has(me) && users.size >= MAX_PARTICIPANTS) return { ok: false, error: `This call is full — up to ${MAX_PARTICIPANTS} people can be in a group call.` };
      const others = Array.from(c.participants.entries()).map(([sid, p]) => ({ socketId: sid, userId: p.userId, name: p.name }));
      c.participants.set(socketId, { userId: me, name: String(data?.name || "Someone"), joinedAt: Date.now() });
      if (c.endTimer) clearTimeout(c.endTimer);
      c.endTimer = null;
      for (const o of others) io.to(o.socketId).emit("gcall:joined", { callId: c.id, socketId, userId: me, name: data?.name || "Someone" });
      io.to(`user:${me}`).except(socketId).emit("gcall:stop-ring", { callId: c.id });
      stopRingPush(c, [me]);
      roomState(c, c.roomId);
      return { ok: true, callId: c.id, roomId: c.roomId, title: c.title, kind: c.kind, startedAt: c.startedAt, participants: others };
    }
    if (type === "signal") {
      const to = String(data?.to || "");
      if (!c.participants.has(socketId) || !c.participants.has(to)) return { ok: true };
      io.to(to).emit("gcall:signal", { callId: c.id, from: socketId, fromUser: me, data: data?.data });
      return { ok: true };
    }
    if (type === "leave") {
      removeSocket(c, socketId);
      return { ok: true };
    }
    return null;
  };

  const clustered = () => io.of("/").adapter.constructor.name !== "Adapter";
  const askOthers = (payload: any): Promise<any[]> =>
    new Promise((resolve) => {
      try {
        (io as any).serverSideEmit("gcall:relay", payload, (err: any, answers: any[]) => resolve(err ? [] : answers || []));
      } catch {
        resolve([]);
      }
    });
  const handleOrRelay = async (type: string, callId: string, me: number, socketId: string, data: any): Promise<any> => {
    const here = type === "find" ? await handle(type, callId, me, socketId, data) : calls.has(callId) ? await handle(type, callId, me, socketId, data) : null;
    if (here || !clustered() || type === "disconnect") return here;
    const answers = await askOthers({ type, callId, me, socketId, data });
    return answers.find((a) => a) || null;
  };
  (io as any).on("gcall:relay", (p: any, done?: (r: any) => void) => {
    const go = p && (p.type === "disconnect" || p.type === "find" || calls.has(String(p.callId)));
    Promise.resolve(go ? handle(String(p.type), String(p.callId), Number(p.me), String(p.socketId), p.data) : null)
      .then((r) => typeof done === "function" && done(r))
      .catch(() => typeof done === "function" && done(null));
  });

  io.on("connection", (socket: Socket) => {
    const me = Number((socket.data as any)?.user?.id);
    if (!me) return;

    socket.on("gcall:start", async (data: { roomId: number; kind: string }, ack?: (r: any) => void) => {
      const reply = (r: any) => ack && ack(r);
      try {
        const roomId = Number(data?.roomId);
        const kind: "audio" | "video" = data?.kind === "video" ? "video" : "audio";
        const mine = await callAccess(me);
        if (!mine.ok) return reply({ ok: false, error: "Calls aren't turned on for your account." });
        const room = ((await queryDB("SELECT id, type, title, send_admins_only FROM chat_rooms WHERE id = ?", [roomId])) || [])[0];
        if (!room || room.type === "direct") return reply({ ok: false, error: "Group calls start from a group chat." });
        const membership = ((await queryDB("SELECT role FROM chat_room_members WHERE room_id = ? AND user_id = ?", [roomId, me])) || [])[0];
        if (!membership) return reply({ ok: false, error: "You're not in this group." });
        // A call already on in this chat: join that one instead.
        const running = await handleOrRelay("find", "", me, socket.id, roomId);
        if (running) return reply({ ok: true, callId: running.callId, kind: running.kind, existing: true });
        // "Only admins can send messages" groups: only admins start calls too.
        if (Number(room.send_admins_only) && membership.role !== "admin" && (socket.data as any)?.user?.role !== "superadmin")
          return reply({ ok: false, error: "Only group admins can start a call in this group." });
        const call: GroupCall = {
          id: crypto.randomUUID(),
          roomId,
          title: room.title || "Group",
          kind,
          startedBy: me,
          startedByName: mine.name,
          startedAt: Date.now(),
          participants: new Map(),
          endTimer: null,
          rung: new Set()
        };
        // Nobody joins (the starter's join fails): it ends by itself.
        call.endTimer = setTimeout(() => {
          if (call.participants.size === 0) finish(call);
        }, EMPTY_END_MS);
        calls.set(call.id, call);
        // Ring the members who can take calls (all their devices).
        const members: any[] = (await queryDB("SELECT user_id FROM chat_room_members WHERE room_id = ? AND user_id <> ?", [roomId, me])) || [];
        const ringIds: number[] = [];
        for (const m of members) {
          if (!(await callAccess(Number(m.user_id))).ok) continue;
          ringIds.push(Number(m.user_id));
          io.to(`user:${m.user_id}`).emit("gcall:incoming", { callId: call.id, roomId, title: call.title, kind, from: { id: me, name: mine.name } });
        }
        // Phones with the app closed / in the background ring too (push).
        if (ringIds.length) {
          for (const id of ringIds) call.rung.add(id);
          void sendSilentPushToUserIds(
            queryDB,
            ringIds,
            { type: "call_incoming", group: "1", callId: call.id, roomId: String(roomId), kind, fromId: String(me), fromName: mine.name, title: call.title },
            RING_MS
          );
        }
        void post(roomId, me, `📞 ${mine.name} started a group ${kind === "video" ? "video" : "audio"} call`, true);
        roomState(call, roomId);
        reply({ ok: true, callId: call.id, kind });
      } catch (err: any) {
        reply({ ok: false, error: err?.message || "Couldn't start the call." });
      }
    });

    socket.on("gcall:join", async (data: { callId: string }, ack?: (r: any) => void) => {
      try {
        const mine = await callAccess(me);
        if (!mine.ok) return ack && ack({ ok: false, error: "Calls aren't turned on for your account." });
        if (inOneToOneCall(me)) return ack && ack({ ok: false, error: "You're already in a call." });
        const r = await handleOrRelay("join", String(data?.callId), me, socket.id, { name: mine.name });
        ack && ack(r || { ok: false, error: "This call has ended." });
      } catch (err: any) {
        ack && ack({ ok: false, error: err?.message || "Couldn't join the call." });
      }
    });
    socket.on("gcall:signal", (data: { callId: string; to: string; data: any }) => void handleOrRelay("signal", String(data?.callId), me, socket.id, { to: data?.to, data: data?.data }));
    socket.on("gcall:leave", (data: { callId: string }) => void handleOrRelay("leave", String(data?.callId), me, socket.id, null));
    socket.on("gcall:decline", (data: { callId: string }) => {
      const callId = String(data?.callId);
      io.to(`user:${me}`).emit("gcall:stop-ring", { callId });
      // Their other phones' call screens stop too.
      const c = calls.get(callId);
      if (c) stopRingPush(c, [me]);
      else void sendSilentPushToUserIds(queryDB, [me], { type: "call_cancel", callId }, RING_MS);
    });
    socket.on("gcall:active", async (data: { roomId: number }, ack?: (r: any) => void) => {
      try {
        const roomId = Number(data?.roomId);
        const member = ((await queryDB("SELECT 1 FROM chat_room_members WHERE room_id = ? AND user_id = ?", [roomId, me])) || []).length > 0;
        ack && ack(member ? await handleOrRelay("find", "", me, socket.id, roomId) : null);
      } catch {
        ack && ack(null);
      }
    });
    socket.on("disconnect", () => {
      void handle("disconnect", "", me, socket.id, null);
      if (clustered()) (io as any).serverSideEmit("gcall:relay", { type: "disconnect", callId: "", me, socketId: socket.id, data: null });
    });
  });
}
