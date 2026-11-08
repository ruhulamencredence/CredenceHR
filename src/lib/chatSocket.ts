/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Chat (Direct/Group/Community messaging) — the one Socket.IO connection for
// this session, shared by ChatPanel.tsx and the Navbar unread badge. Kept as
// a single module-level singleton (rather than one per component) so
// switching between rooms/tabs doesn't tear down and reconnect the socket —
// same reasoning as backgroundTracking.ts keeping one watcher for the whole
// app session. Connects to the same origin the app itself was loaded from —
// see api.ts's apiUrl comment for why that's correct on both the web build
// and the Android APK (Capacitor's WebView points straight at a real server
// URL, so there's no separate base URL to configure here either).
//
// Server-side: server.ts creates the Socket.IO server on the exact same
// http.Server the Express app and Vite's own HMR WebSocket already share
// (see ChatRoutes.ts's setupChatSocket / server.ts's `const io = new
// SocketIOServer(httpServer, ...)`), so this needs no separate host/port.

import { io, Socket } from 'socket.io-client';
import { refreshNotices } from './noticesLive';
import { setLiveUntil } from './backgroundTracking';
import { RECORDS_CHANGED_EVENT } from './liveRefresh';

let socket: Socket | null = null;
let connectedToken: string | null = null;

// Call once right after login (and keep calling on every token change —
// mirrors startBackgroundTracking's re-entrant guard). No-ops if already
// connected for this exact token.
export function connectChatSocket(token: string): Socket {
  if (socket && connectedToken === token) return socket;
  if (socket) socket.disconnect();

  connectedToken = token;
  socket = io({
    auth: { token },
    // Matches AlertsBell/background-tracking's own retry posture: keep
    // trying quietly rather than giving up after a burst of attempts — a
    // flaky mobile connection shouldn't permanently kill live chat for the
    // rest of the session.
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 15000,
    // WebSocket straight away: one connection that stays on one server
    // process. The default (start with HTTP long-polling, then upgrade)
    // sends several separate requests, which under PM2 cluster mode land
    // on different workers and break the connection. Long-polling remains
    // the fallback for a network that blocks WebSockets.
    transports: ['websocket', 'polling'],
    tryAllTransports: true
  });
  // Notices (NoticePopup): a new one shows at once; after a reconnect, one
  // published while the app was asleep/offline does too.
  socket.on('notices:changed', refreshNotices);
  socket.io.on('reconnect', refreshNotices);
  // Employee Tracking -> Live Follow: an Admin opened this person (or a ride
  // started) — report location every few seconds until the given time.
  socket.on('tracking:live', (d: { until: number | null }) => setLiveUntil(d?.until));
  // A request of this account changed, or a new one waits for it: open pages
  // refresh (src/lib/liveRefresh.ts). After a reconnect everything refreshes once.
  socket.on('records:changed', (d: any) => window.dispatchEvent(new CustomEvent(RECORDS_CHANGED_EVENT, { detail: d })));
  socket.io.on('reconnect', () => window.dispatchEvent(new CustomEvent(RECORDS_CHANGED_EVENT, { detail: null })));
  return socket;
}

export function disconnectChatSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  connectedToken = null;
}

// Returns the current socket, or null if connectChatSocket() hasn't been
// called yet (e.g. before login). Components should still guard every use
// with `?.` — the socket can also legitimately disconnect/reconnect anytime.
export function getChatSocket(): Socket | null {
  return socket;
}
