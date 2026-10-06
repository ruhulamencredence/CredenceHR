/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Tracking -> Live Follow (Google-Maps-style live location).
//
// Phones normally ping every 3-10 minutes to save battery. A phone switches
// to "live" (a ping every few seconds) only while it is worth it:
//   - someone with the tracking "live" layer has that person open in Live
//     Follow (POST .../watch, renewed every WATCH_TTL_MS by the open page), or
//   - the person is the requester or the driver of an ongoing Book a Ride ride.
// The phone learns it is live from a socket event ("tracking:live") and, as a
// fallback, from the reply to its own ping ({ live_until }). Every ping that
// arrives while someone is watching is pushed straight to the watchers'
// sockets ("tracking:location"), so the map moves without polling.
//
// Watchers are kept in memory: a restart just means an open Live Follow page
// re-registers on its next renewal.

import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";

interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (key: "tracking") => any;
  requireModuleLayer: (key: "tracking", layer: "live") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  getIo: () => SocketIOServer | null;
}

// How long one watch request keeps a phone live; the page renews it well
// before then, so closing the page lets the phone slow down again soon after.
const WATCH_TTL_MS = 90_000;
// Ongoing-ride lookups are cached so a phone pinging every few seconds doesn't
// query vehicle_requisitions every time.
const RIDE_CACHE_MS = 30_000;
// While a ride is ongoing, the phone is told to stay live this long past
// each ping (it keeps renewing as long as the ride is still on).
const RIDE_LIVE_MS = 2 * 60_000;

export interface LiveTracking {
  // Called by POST /api/tracking/ping after the ping is stored. Pushes it to
  // anyone watching and returns when the phone should stay live until (ms).
  onPing: (userId: number, ping: { lat: number; lng: number; accuracy_m: number | null; battery_pct: number | null; recorded_at: Date }) => Promise<number | null>;
}

export function registerLiveTrackingRoutes(app: Express, deps: Deps): LiveTracking {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB, getIo } = deps;

  // tracked user id -> (watcher user id -> expires at)
  const watchers = new Map<number, Map<number, number>>();
  const rideCache = new Map<number, { at: number; live: boolean }>();

  const activeWatchers = (userId: number): number[] => {
    const m = watchers.get(userId);
    if (!m) return [];
    const now = Date.now();
    for (const [w, exp] of m) if (exp <= now) m.delete(w);
    if (m.size === 0) watchers.delete(userId);
    return Array.from(m.keys());
  };
  const watchUntil = (userId: number): number | null => {
    activeWatchers(userId);
    const m = watchers.get(userId);
    return m && m.size ? Math.max(...m.values()) : null;
  };

  const onRide = async (userId: number): Promise<boolean> => {
    const hit = rideCache.get(userId);
    if (hit && Date.now() - hit.at < RIDE_CACHE_MS) return hit.live;
    let live = false;
    try {
      const rows = await queryDB(
        "/*unscoped*/ SELECT id FROM vehicle_requisitions WHERE status = 'ongoing' AND (employee_user_id = ? OR driver_user_id = ?) LIMIT 1",
        [userId, userId]
      );
      live = rows.length > 0;
    } catch {
      live = false;
    }
    rideCache.set(userId, { at: Date.now(), live });
    return live;
  };

  const liveUntil = async (userId: number): Promise<number | null> => {
    const w = watchUntil(userId);
    const r = (await onRide(userId)) ? Date.now() + RIDE_LIVE_MS : null;
    if (w == null && r == null) return null;
    return Math.max(w || 0, r || 0);
  };

  const tellPhone = (userId: number, until: number | null) => {
    getIo()?.to(`user:${userId}`).emit("tracking:live", { until });
  };

  // Start (or renew) following someone. Also returns their latest ping and
  // today's path so the map has something to draw at once.
  app.post(
    "/api/tracking/live/:userId/watch",
    authenticateToken,
    requireAdmin,
    requireModule("tracking"),
    requireModuleLayer("tracking", "live"),
    async (req: any, res: any) => {
      try {
        const userId = Number(req.params.userId);
        if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: "Invalid employee." });
        // Scoped read (same as the live board): only someone this account can
        // already see on Employee Tracking can be followed.
        const latest = await queryDB(
          "SELECT lat, lng, accuracy_m, battery_pct, recorded_at FROM location_pings WHERE user_id = ? ORDER BY recorded_at DESC LIMIT 1",
          [userId]
        );
        if (latest.length === 0) return res.status(404).json({ error: "This employee hasn't sent a location yet." });
        const userRows = await queryDB("SELECT id, name FROM users WHERE id = ?", [userId]);
        if (userRows.length === 0) return res.status(404).json({ error: "Employee not found." });

        let m = watchers.get(userId);
        const wasLive = !!(m && activeWatchers(userId).length);
        if (!m) watchers.set(userId, (m = new Map()));
        m.set(Number(req.user.id), Date.now() + WATCH_TTL_MS);
        const until = await liveUntil(userId);
        if (!wasLive) tellPhone(userId, until);

        // The first call of a session also sends today's path; renewals skip it.
        let trail: any[] = [];
        if (req.body?.with_trail) {
          trail = await queryDB(
            "SELECT lat, lng, recorded_at FROM location_pings WHERE user_id = ? AND recorded_at >= CURDATE() ORDER BY recorded_at ASC",
            [userId]
          );
        }
        res.json({
          user: { id: userId, name: userRows[0].name },
          latest: latest[0],
          trail: trail.map((p: any) => ({ lat: Number(p.lat), lng: Number(p.lng), recorded_at: p.recorded_at })),
          live_until: until,
          on_ride: await onRide(userId)
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  // Stop following (page closed). The phone drops back to normal once no one
  // else is watching and no ride is on.
  app.post(
    "/api/tracking/live/:userId/unwatch",
    authenticateToken,
    requireAdmin,
    requireModule("tracking"),
    requireModuleLayer("tracking", "live"),
    async (req: any, res: any) => {
      const userId = Number(req.params.userId);
      watchers.get(userId)?.delete(Number(req.user.id));
      const until = await liveUntil(userId);
      if (until == null) tellPhone(userId, null);
      res.json({ success: true });
    }
  );

  return {
    onPing: async (userId, ping) => {
      const ws = activeWatchers(userId);
      if (ws.length) {
        const io = getIo();
        const payload = {
          user_id: userId,
          lat: ping.lat,
          lng: ping.lng,
          accuracy_m: ping.accuracy_m,
          battery_pct: ping.battery_pct,
          recorded_at: ping.recorded_at.toISOString()
        };
        for (const w of ws) io?.to(`user:${w}`).emit("tracking:location", payload);
      }
      return liveUntil(userId);
    }
  };
}
