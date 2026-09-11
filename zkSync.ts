// zkSync.ts
// Captures attendance punches from the office ZKTeco terminals over LAN (TCP,
// port 4370 by default) and stores them in zk_attendance_logs, WITHOUT ever
// deleting or clearing anything on the devices themselves.
//
// Default mechanism: scheduled polling (startZkSyncSchedule). Real-time push
// (getRealTimeLogs, via startZkRealtimeListeners) was tried first but proved
// unreliable in practice — punches like a 6:00pm checkout wave weren't
// appearing until someone clicked "Sync Now" by hand — so the schedule below
// does NOT depend on it. Instead it repeats the same full pull "Sync Now"
// uses (syncAllZkDevices) automatically, on a short interval, so a punch
// shows up in the app within seconds instead of needing a manual click:
//   08:00–11:00   full pull every 15 seconds
//   15:00          one extra full pull
//   17:59–20:00   full pull every 15 seconds
//   02:00          one extra full pull
// Each pull re-downloads a device's ENTIRE log — there's no "since date"
// filter in the ZK protocol — which is exactly why this only runs on a
// schedule/interval rather than continuously.
//
// Safe to run repeatedly — INSERT IGNORE on the (device_id, device_user_pin,
// punch_time) unique key means re-seeing the same punch across polls (or
// from a manual Sync Now in between) never duplicates rows. Requires the
// machine running this Express server to be on the same office LAN as the
// ZK terminals (or reachable via VPN/routing to them).
//
// startZkRealtimeListeners/stopZkRealtimeListeners are still defined and
// exported below in case real-time push is worth revisiting later (e.g.
// after a node-zklib version bump, or if a different firmware behaves
// better) — they're just not called from startZkSyncSchedule for now.
//
// npm install node-zklib node-cron

import ZKLib from "node-zklib";
import cron from "node-cron";
import type { Pool } from "mysql2/promise";

interface ZkDeviceRow {
  id: number;
  name: string;
  ip_address: string;
  port: number;
  is_active: number;
}

// node-zklib doesn't always reject with a proper Error — depending on the
// failure (refused connection, garbled reply, internal timeout race) it can
// reject with a plain string, an object like { err: 'timeout' }, or similar.
// This pulls out something readable no matter the shape, instead of the
// "error: undefined" you'd get from a bare `err.message`.
function describeError(err: any): string {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err.message) return String(err.message);
  if (err.err) return String(err.err);
  if (err.code) return String(err.code);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Hard ceiling per device so one unresponsive terminal can never stall the
// whole sync run indefinitely — node-zklib's own internal timeout parameter
// isn't reliably honored for every failure mode (e.g. a device that accepts
// the TCP handshake but then never replies to the actual protocol request),
// so this is a second, independent safety net around the whole operation.
//
// Raised from 20s -> 60s: getAttendances() re-downloads a device's FULL log
// history every run (there's no "since date" filter in the protocol), so the
// time this takes only grows as a device's buffer fills up. 20s was already
// marginal for devices on a weaker network path even before their log count
// caught up to busier terminals — 60s gives real headroom without letting a
// truly dead device hang forever.
const DEVICE_SYNC_TIMEOUT_MS = 60_000;

// A quick getInfo() call (separate from the full getAttendances() pull) so
// we can log how many records a device is actually holding. Kept short and
// non-fatal on failure — its only job is to make timeouts diagnosable later
// ("was this device just huge, or is the network to it bad?").
const INFO_TIMEOUT_MS = 10_000;

// One retry after a short pause absorbs transient network blips (a dropped
// packet, a momentary Wi-Fi hiccup) without masking a device that's
// genuinely offline — that one will still fail on the retry too.
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 5_000;

// Real-time listener settings. The initial handshake gets a short timeout
// (it's just a connect, not a data transfer). getRealTimeLogs() itself is
// NOT a blocking call in node-zklib — it registers the device to push new
// punches over the already-open socket and resolves almost immediately,
// while the library keeps listening on that socket in the background. So
// we hold the connection open after registering (never disconnect just
// because that promise resolved) and only proactively cycle it once in a
// while as a precaution against silently-dropped idle connections — not
// because anything failed.
const REALTIME_CONNECT_TIMEOUT_MS = 15_000;
const REALTIME_RECONNECT_DELAY_MS = 15_000;
const REALTIME_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h — longer than
// any listening window below, so in practice a window's own scheduled stop
// (11:00 / 20:00) ends the connection before this refresh ever fires; it's
// only a safety net if a window were ever widened.

// ---- Scheduled sync windows (server local time) ----
// Real-time push (startZkRealtimeListeners, via node-zklib's
// getRealTimeLogs) turned out unreliable in practice — e.g. the 6:00pm
// checkout wave wasn't showing up on its own; it only appeared after
// someone clicked "Sync Now" by hand. So the schedule below does NOT rely
// on the real-time listeners at all. Instead it repeats the exact same
// full pull the "Sync Now" button uses (syncAllZkDevices) on a tight
// interval, but only during the requested windows:
//   08:00 – 11:00   poll every 15 seconds
//   15:00            one full pull
//   17:59 – 20:00   poll every 15 seconds
//   02:00            one full pull
// startZkRealtimeListeners/stopZkRealtimeListeners (further below) are
// left in the file and still exported in case real-time push is worth
// revisiting later — they're just not wired into this schedule for now.

// Master on/off switch checked by every device's listener loop. Flipped by
// startZkRealtimeListeners / stopZkRealtimeListeners — not called from the
// default schedule below, kept only for manual/future use.
let realtimeEnabled = false;

// Device ids that currently have a listener loop running, so a second call
// to startZkRealtimeListeners (e.g. a manual restart mid-window) never
// spins up a duplicate loop for the same device.
const runningDevices = new Set<number>();

// Currently-open real-time sockets, so stopZkRealtimeListeners can force a
// disconnect immediately instead of waiting for the loop to notice.
const activeZkSockets = new Map<number, ZKLib>();

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Formats a JS Date using its LOCAL wall-clock components (not UTC) into a
// MySQL DATETIME literal. Using .toISOString() here would be wrong — it
// converts to UTC first, which silently shifts every punch by the server's
// UTC offset (e.g. -6h for Bangladesh) since MySQL's DATETIME column stores
// whatever digits it's given with no timezone attached. The device already
// reports local wall-clock time, so we must round-trip it as local, not UTC.
function toMysqlDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Shared by both the full reconciliation pull and the real-time listener —
// one punch record in, one INSERT IGNORE out. Returns false (no-op) for a
// malformed record instead of throwing, since a single bad row from either
// path shouldn't take down the whole batch/connection.
async function insertPunchRow(dbPool: Pool, deviceId: number, log: any): Promise<boolean> {
  // node-zklib returns { userId/deviceUserId, recordTime, ... } depending on
  // device firmware — deviceUserId is the PIN enrolled on the terminal.
  const pin = String(log.deviceUserId ?? log.userId ?? "").trim();
  const punchTime = log.recordTime ?? log.attTime;
  if (!pin || !punchTime) return false;

  const mysqlDateTime = toMysqlDateTimeLocal(new Date(punchTime));
  await dbPool.execute(
    `INSERT IGNORE INTO zk_attendance_logs (device_id, device_user_pin, punch_time, verify_mode, work_code)
     VALUES (?, ?, ?, ?, ?)`,
    [deviceId, pin, mysqlDateTime, log.verifyMode ?? null, log.workCode ?? null]
  );
  return true;
}

// Pulls the full attendance log currently stored on one device and upserts
// it into zk_attendance_logs. Each device's own retry/backoff is isolated —
// one offline device never blocks the others.
//
// `attempt` is internal (used for the retry recursion below) — callers
// should just call syncZkDevice(dbPool, device).
export async function syncZkDevice(
  dbPool: Pool,
  device: ZkDeviceRow,
  attempt: number = 1
): Promise<{ ok: boolean; count: number; error?: string }> {
  // Bumped connection timeout from 10000 -> 30000 to match the more
  // generous DEVICE_SYNC_TIMEOUT_MS ceiling above.
  const zk = new ZKLib(device.ip_address, device.port, 30000, 4000);

  // How many records the device itself reports holding, if we can get it
  // cheaply. Purely informational — lets last_sync_status distinguish "this
  // device just has a lot of logs" from "this device's network path is bad".
  let deviceLogCount: number | null = null;

  try {
    await withTimeout(zk.createSocket(), DEVICE_SYNC_TIMEOUT_MS, "createSocket");

    try {
      const info: any = await withTimeout(zk.getInfo(), INFO_TIMEOUT_MS, "getInfo");
      deviceLogCount = info?.logCounts ?? info?.attendanceCount ?? info?.logCapacity ?? null;
    } catch {
      // Non-fatal — some firmware doesn't answer getInfo reliably either,
      // and it isn't the call we actually need to succeed.
    }

    const logs = await withTimeout(zk.getAttendances(), DEVICE_SYNC_TIMEOUT_MS, "getAttendances");
    const rows: any[] = logs?.data || [];

    let count = 0;
    for (const log of rows) {
      if (await insertPunchRow(dbPool, device.id, log)) count++;
    }

    const countNote = deviceLogCount != null ? `, device reports ${deviceLogCount} total` : "";
    await dbPool.execute(
      `UPDATE zk_devices SET last_synced_at = NOW(), last_sync_status = ? WHERE id = ?`,
      [`ok (${count} logs seen${countNote})`.slice(0, 255), device.id]
    );

    try { await zk.disconnect(); } catch {}
    return { ok: true, count };
  } catch (err: any) {
    const message = describeError(err);
    try { await zk.disconnect(); } catch {}

    // One retry after a short pause — a fresh socket, not a re-use of the
    // failed one. If the retry also fails, this is very likely a genuinely
    // offline/unreachable device rather than a one-off blip.
    if (attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
      return syncZkDevice(dbPool, device, attempt + 1);
    }

    const countNote = deviceLogCount != null ? ` [device reports ${deviceLogCount} logs]` : "";
    const attemptsNote = attempt > 1 ? ` (after ${attempt} attempts)` : "";
    try {
      await dbPool.execute(`UPDATE zk_devices SET last_sync_status = ? WHERE id = ?`, [
        `error: ${message}${countNote}${attemptsNote}`.slice(0, 255),
        device.id
      ]);
    } catch {}
    return { ok: false, count: 0, error: message };
  }
}

// Pulls every active device at once, in parallel — each device gets its
// own independent connection/route, so one slow or offline device never
// makes the others wait (previously this looped and awaited one device at
// a time, so a single unresponsive device could hold up the entire batch
// for up to DEVICE_SYNC_TIMEOUT_MS before the next device even started —
// that serialization was fighting against the short 15s poll interval
// above, since one run of this function had to fully finish, one device
// after another, before the next poll tick could begin).
export async function syncAllZkDevices(dbPool: Pool): Promise<{ device: string; ok: boolean; count: number; error?: string }[]> {
  const [devices] = (await dbPool.query(`SELECT * FROM zk_devices WHERE is_active = 1`)) as any;
  const results = await Promise.all(
    (devices as ZkDeviceRow[]).map(async (device) => {
      const result = await syncZkDevice(dbPool, device);
      return { device: device.name, ...result };
    })
  );
  return results;
}

// Wipes a device's onboard attendance buffer. NOT used anywhere in this
// file — nothing here ever clears device data, by design, per your
// instruction that old data must never be deleted from the terminals.
// Left in only as a standalone, manually-callable option in case that
// changes for you down the line; nothing wires it up automatically.
export async function clearZkDeviceLog(dbPool: Pool, device: ZkDeviceRow): Promise<{ ok: boolean; error?: string }> {
  const zk = new ZKLib(device.ip_address, device.port, 30000, 4000);
  try {
    await withTimeout(zk.createSocket(), DEVICE_SYNC_TIMEOUT_MS, "createSocket");
    await withTimeout(zk.clearAttendanceLog(), DEVICE_SYNC_TIMEOUT_MS, "clearAttendanceLog");
    try { await zk.disconnect(); } catch {}
    return { ok: true };
  } catch (err: any) {
    const message = describeError(err);
    try { await zk.disconnect(); } catch {}
    return { ok: false, error: message };
  }
}

// Runs one full pull across all devices and logs any per-device failures.
// This is the exact same function the manual "Sync Now" button calls
// (POST /api/zk-devices/sync-now → syncAllZkDevices) — the schedule below
// just calls it automatically, on a timer, instead of waiting for a click.
async function runReconciliationSync(dbPool: Pool): Promise<void> {
  const results = await syncAllZkDevices(dbPool);
  for (const r of results) {
    if (!r.ok) console.warn(`⚠️ ZK sync failed for ${r.device}: ${r.error}`);
  }
}

// How often to poll during a window. Cron's finest granularity is one
// minute, so this uses a plain setInterval instead — checked every tick,
// but a sync only actually runs when isInPollWindow() is true. 15s is as
// close to "punch → shows up right away" as a polling-only approach can
// get: true instant would need reliable real-time push, which testing
// showed isn't dependable on these devices (see file header) — this is
// the closest practical substitute, at the cost of re-downloading each
// device's full log up to 4x/minute while a window is open.
const POLL_INTERVAL_MS = 15 * 1000;
let pollInProgress = false;

function isInPollWindow(date: Date): boolean {
  // Read the hour/minute in Asia/Dhaka specifically — date.getHours() reads
  // whatever timezone the Node process itself is running in, which on most
  // hosting isn't Dhaka (it's usually UTC). If the server's local time isn't
  // Dhaka, every window here silently drifts by the UTC offset (6h) and the
  // 15:00/02:00 full pulls below fire at the wrong wall-clock moment in
  // Bangladesh — this is the same class of bug the app already works around
  // elsewhere via todayInDhaka().
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Dhaka",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const hour = Number(parts.find(p => p.type === "hour")!.value);
  const minute = Number(parts.find(p => p.type === "minute")!.value);
  const minutes = hour * 60 + minute;
  const inMorning = minutes >= 8 * 60 && minutes < 11 * 60;       // 08:00–11:00
  const inEvening = minutes >= 17 * 60 + 59 && minutes < 20 * 60; // 17:59–20:00
  return inMorning || inEvening;
}

// Call this once from server.ts after dbPool is ready (inside initDB(), after
// the pool is created). Wires up the daily schedule:
//   08:00–11:00   full pull every 15 seconds
//   15:00          one extra full pull
//   17:59–20:00   full pull every 15 seconds
//   02:00          one extra full pull
// Adjust isInPollWindow / POLL_INTERVAL_MS / the two cron lines below if
// these windows or the cadence ever need to change.
export function startZkSyncSchedule(dbPool: Pool) {
  // Ticks every POLL_INTERVAL_MS; only actually syncs when (a) inside a
  // window, and (b) no previous poll is still running — a slow device (or
  // several) can make one run take longer than 15s, and this stops runs
  // from stacking up on top of each other; the next tick just skips until
  // the in-flight one finishes.
  setInterval(async () => {
    const now = new Date();
    if (!isInPollWindow(now)) return;
    if (pollInProgress) return;

    pollInProgress = true;
    try {
      await runReconciliationSync(dbPool);
    } catch (err) {
      console.error(`❌ ZK window poll crashed: ${describeError(err)}`);
    } finally {
      pollInProgress = false;
    }
  }, POLL_INTERVAL_MS);

  // Both cron.schedule calls below are pinned to Asia/Dhaka explicitly —
  // node-cron otherwise runs on the SERVER's local timezone, which drifts
  // from Bangladesh time on most hosting (typically UTC). Without this,
  // "15:00" and "02:00" here silently meant 15:00/02:00 server-local time,
  // not Dhaka time — e.g. on a UTC host, the "15:00" pull would actually
  // fire at 21:00 Dhaka time, and "02:00" at 08:00 Dhaka time.
  cron.schedule("0 15 * * *", () => {
    runReconciliationSync(dbPool).catch(err =>
      console.error(`❌ ZK 15:00 sync crashed: ${describeError(err)}`)
    );
  }, { timezone: "Asia/Dhaka" });

  cron.schedule("0 2 * * *", () => {
    runReconciliationSync(dbPool).catch(err =>
      console.error(`❌ ZK 02:00 sync crashed: ${describeError(err)}`)
    );
  }, { timezone: "Asia/Dhaka" });

  console.log("✅ ZK attendance sync scheduled: polling every 15s during 08:00–11:00 & 17:59–20:00, plus full pulls at 15:00 & 02:00");
}

// Keeps one persistent connection open per device, receiving each new punch
// the instant it happens instead of periodically re-downloading the whole
// history — in theory. NOT called by the default startZkSyncSchedule above
// (see the file header): in testing, punches weren't reliably showing up
// live through this path, so the schedule uses interval polling instead.
// Left here, still exported, in case it's worth revisiting later.
//
// IMPORTANT: getRealTimeLogs() resolving does NOT mean the connection ended
// — it means registration succeeded and node-zklib is now listening on this
// same socket in the background. We deliberately do NOT disconnect after
// that resolves; we hold the connection open (REALTIME_REFRESH_INTERVAL_MS)
// and only cycle it periodically as a precaution against a connection that
// silently died without either side noticing (some network gear drops
// long-idle TCP sessions quietly) — not as a response to any error.
//
// Self-healing on genuine failures: if createSocket() or getRealTimeLogs()
// itself throws (device offline, network down), this retries after a short
// pause and keeps trying until stopped via stopZkRealtimeListeners.
async function listenRealtimeForDevice(dbPool: Pool, device: ZkDeviceRow): Promise<void> {
  // Guard against a duplicate loop for the same device (e.g. someone calls
  // startZkRealtimeListeners again while a window is already open).
  if (runningDevices.has(device.id)) return;
  runningDevices.add(device.id);

  try {
    while (realtimeEnabled) {
      const zk = new ZKLib(device.ip_address, device.port, 30000, 4000);
      try {
        await withTimeout(zk.createSocket(), REALTIME_CONNECT_TIMEOUT_MS, "createSocket (real-time)");
        activeZkSockets.set(device.id, zk);
        await zk.getRealTimeLogs(async (log: any) => {
          try {
            await insertPunchRow(dbPool, device.id, log);
          } catch (err) {
            console.warn(`⚠️ Failed to save a real-time punch from ${device.name}: ${describeError(err)}`);
          }
        });
        console.log(`📡 Real-time listening started for ${device.name} (${device.ip_address})`);

        // Hold the connection open, but re-check realtimeEnabled every few
        // seconds instead of sleeping the whole REALTIME_REFRESH_INTERVAL_MS
        // in one go — this is what lets a scheduled stop (11:00 / 20:00)
        // take effect within seconds instead of hours.
        const wakeAt = Date.now() + REALTIME_REFRESH_INTERVAL_MS;
        while (realtimeEnabled && Date.now() < wakeAt) {
          await sleep(5_000);
        }

        activeZkSockets.delete(device.id);
        try { await zk.disconnect(); } catch {}

        if (!realtimeEnabled) {
          console.log(`⏸️ Real-time listening stopped for ${device.name} (scheduled off-window)`);
          break;
        }
        console.log(`🔄 Refreshing real-time connection to ${device.name} (scheduled, not an error)`);
        continue;
      } catch (err) {
        activeZkSockets.delete(device.id);
        console.warn(`⚠️ Real-time connection to ${device.name} failed: ${describeError(err)} — retrying in ${REALTIME_RECONNECT_DELAY_MS / 1000}s…`);
        try { await zk.disconnect(); } catch {}
        if (!realtimeEnabled) break;
        await sleep(REALTIME_RECONNECT_DELAY_MS);
      }
    }
  } finally {
    runningDevices.delete(device.id);
  }
}

// Starts a real-time listener for every active device (idempotent — safe to
// call again while listeners are already running). Each device's loop runs
// independently in the background (fire-and-forget) until stopped — one
// device being offline never affects the others' listeners.
export async function startZkRealtimeListeners(dbPool: Pool): Promise<void> {
  realtimeEnabled = true;
  const [devices] = (await dbPool.query(`SELECT * FROM zk_devices WHERE is_active = 1`)) as any;
  for (const device of devices as ZkDeviceRow[]) {
    listenRealtimeForDevice(dbPool, device); // no-op if a loop is already running for this device
  }
  console.log(`✅ ZK real-time listeners starting for ${(devices as ZkDeviceRow[]).length} device(s)`);
}

// Stops all real-time listeners immediately (used at the end of a
// listening window, e.g. 11:00 and 20:00). Flips the shared flag so every
// device's loop exits on its next check, and force-disconnects any socket
// that's currently open rather than waiting for that to happen naturally.
export function stopZkRealtimeListeners(): void {
  realtimeEnabled = false;
  for (const zk of activeZkSockets.values()) {
    zk.disconnect().catch(() => {});
  }
  activeZkSockets.clear();
  console.log("⏸️ ZK real-time listeners stopping (scheduled off-window)");
}