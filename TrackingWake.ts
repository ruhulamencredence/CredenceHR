/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Tracking watchdog. Phones stop background apps to save battery
// (battery optimisation, Xiaomi / Oppo / Vivo "battery saver") even when the
// app's tracking service (DutyTrackingService.java) is meant to run. Every
// few minutes this finds tracked phones that have gone quiet and sends each
// a silent high-priority push ("tracking_wake"); Android lets such a push
// start the tracking service again, even with the app closed and battery
// optimisation on. Phones that were not tracking (signed out, tracking off)
// ignore it.

import { sendSilentPushToUserIds } from "./PushNotificationService";
import { trackingWindowsFor } from "./TrackingSchedule";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

const EVERY_MS = 5 * 60 * 1000;
// Quiet for this long = probably stopped (the phone reports every 2 min).
const QUIET_MIN = 12;
// Only phones heard from in the last day (a phone not used for tracking
// any more is left alone).
const RECENT_HOURS = 24;
// A phone paused by its Tracking Schedule is woken at its next start if it
// paused within this many days.
const OFF_SCHEDULE_DAYS = 14;
// At most one wake-up per phone this often.
const WAKE_GAP_MS = 15 * 60 * 1000;

const lastWake = new Map<number, number>();

export async function wakeQuietTrackers(queryDB: QueryDB): Promise<number> {
  // A phone stopped by its Tracking Schedule (mode "off_sched") is woken
  // when its next tracking time starts, however long it was off (a weekend).
  const rows: any[] =
    (await queryDB(
      `/*unscoped*/ SELECT s.user_id, e.id AS employee_pk FROM tracking_device_state s JOIN users u ON u.id = s.user_id
       LEFT JOIN all_employees e ON e.user_id = s.user_id
       WHERE u.can_use_tracking = 1 AND COALESCE(u.is_blocked, 0) = 0
         AND s.reported_at < NOW() - INTERVAL ${QUIET_MIN} MINUTE
         AND (s.reported_at > NOW() - INTERVAL ${RECENT_HOURS} HOUR
              OR (s.mode = 'off_sched' AND s.reported_at > NOW() - INTERVAL ${OFF_SCHEDULE_DAYS} DAY))`
    ).catch(() => [])) || [];
  // …and never while outside it.
  const windows = await trackingWindowsFor(
    queryDB,
    rows.map((r) => ({ user_id: Number(r.user_id), employee_pk: r.employee_pk ? Number(r.employee_pk) : null }))
  ).catch(() => new Map());
  const now = Date.now();
  const ids = Array.from(new Set(rows.map((r) => Number(r.user_id))))
    .filter((id) => windows.get(id)?.on !== false)
    .filter((id) => now - (lastWake.get(id) || 0) >= WAKE_GAP_MS);
  if (ids.length === 0) return 0;
  for (const id of ids) lastWake.set(id, now);
  return sendSilentPushToUserIds(queryDB, ids, { type: "tracking_wake" }, 10 * 60 * 1000);
}

export function startTrackingWakeJob(queryDB: QueryDB) {
  setInterval(() => void wakeQuietTrackers(queryDB).catch(() => 0), EVERY_MS);
}
