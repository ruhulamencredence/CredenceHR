/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Tracking (Admin Panel -> Employee Tracking) — the mobile-app side.
// Only ever active on the native APK build (Capacitor.isNativePlatform()) for
// an account with can_use_tracking granted (Admin Panel -> Users -> Feature
// Permissions). Uses @capacitor-community/background-geolocation instead of
// @capacitor/geolocation (already used for one-off reads at login/Attendance/
// Claims) because that plugin stops delivering updates the moment the app is
// backgrounded — this one keeps going via an Android foreground service, at
// the cost of needing the extra ACCESS_BACKGROUND_LOCATION/FOREGROUND_SERVICE
// permissions declared in AndroidManifest.xml and a persistent notification
// telling the user tracking is active (Android requires this; it can't be
// hidden — see strings.xml for its text/icon/color).
//
// Design: the watcher's callback can still fire more often than we want to
// hit the network, so we DON'T send a request from inside it. Instead we just
// remember the latest fix in memory, and a separate timer (the ping interval)
// POSTs whatever the latest fix is every few minutes. This decouples "how
// often the OS reports a GPS fix" from "how often we hit the server" — but
// the OS-reporting frequency itself is controlled separately by the
// distanceFilter below, which is the actual battery lever; the ping interval
// only controls network/data usage, not GPS power draw.
//
// Adaptive active/idle mode: there's no direct Capacitor API for a
// Significant-Motion/accelerometer trigger (that needs a custom native
// plugin), so this settles for a cheaper approximation — if no new fix has
// arrived for IDLE_AFTER_MS, the device is almost certainly stationary
// (desk/home, not just walking slowly), so we re-arm the watcher with a much
// coarser distanceFilter and back off the ping interval. That means the OS
// is asked for far fewer/lower-power location updates while idle, without
// giving up on detecting movement — the moment a fix does arrive (i.e. the
// device moved past the coarse threshold), we snap straight back to the
// tight "active" settings.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { apiUrl } from './api';
import { getLocationConsent } from './locationDisclosure';

interface BGLocation {
  latitude: number;
  longitude: number;
  accuracy: number;
  time: number;
}

interface BackgroundGeolocationPlugin {
  addWatcher(
    options: {
      backgroundMessage?: string;
      backgroundTitle?: string;
      requestPermissions?: boolean;
      stale?: boolean;
      distanceFilter?: number;
    },
    callback: (location: BGLocation | undefined, error: any) => void
  ): Promise<string>;
  removeWatcher(options: { id: string }): Promise<void>;
  openSettings(): Promise<void>;
}

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

// "Active" settings — used right after a fix arrives, i.e. while the device
// is known (or assumed) to still be moving.
// 25m is tight enough that normal walking-speed movement shows up within a
// fix or two instead of minutes, but still lets the native side use a
// coarser/lower-power location request than distanceFilter: 0 (continuous
// max-frequency, max-power updates — that's what caused the original battery
// drain).
const ACTIVE_DISTANCE_FILTER_M = 25;
// Network pings themselves are cheap (a tiny POST, not a GPS read), so this
// is tight mostly to keep the admin-side "last seen" fresh while movement is
// actually happening.
const ACTIVE_PING_INTERVAL_MS = 3 * 60 * 1000;

// "Idle" settings — switched to once IDLE_AFTER_MS has passed with no new
// fix (device hasn't moved ACTIVE_DISTANCE_FILTER_M in that whole window).
// A much coarser distanceFilter means the OS requests location far less
// often/precisely while the person is sitting at a desk or asleep, which is
// where the real battery saving comes from — this is the one lever that
// actually reduces GPS radio wake-ups, not just network traffic.
const IDLE_DISTANCE_FILTER_M = 120;
const IDLE_PING_INTERVAL_MS = 10 * 60 * 1000;
const IDLE_AFTER_MS = 15 * 60 * 1000;

// "Live" settings — only while an Admin has this person open in Live Follow
// or they are on an ongoing Book a Ride ride (the server says until when, via
// the "tracking:live" socket event or the reply to a ping). A fresh fix is
// sent at once (at most every LIVE_MIN_GAP_MS) plus a heartbeat every
// LIVE_PING_INTERVAL_MS, so the Admin's map moves like Google Maps. Drops back
// to active mode by itself when the time runs out.
const LIVE_DISTANCE_FILTER_M = 5;
const LIVE_PING_INTERVAL_MS = 5 * 1000;
const LIVE_MIN_GAP_MS = 3 * 1000;

let watcherId: string | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let idleCheckTimer: ReturnType<typeof setInterval> | null = null;
let latestFix: BGLocation | null = null;
let currentToken: string | null = null;
// The token tracking was last asked to run for, kept even when starting
// failed (no permission yet), so the set-up card can start it once the
// permission is given.
let requestedToken: string | null = null;
let mode: 'active' | 'idle' | 'live' = 'active';
let liveUntil = 0;
let lastSentAt = 0;
let lastSentFixTime = 0;
let lastFixAt = 0;
let switchingMode = false;
// Every fix since the last successful send, oldest first — a trip is sent as
// its whole path, not just the last point of each interval.
let pendingFixes: BGLocation[] = [];
const MAX_PENDING_FIXES = 300;
// The phone's own heartbeat (is Location on? permission kept?) — sent even
// when there is no fix, so the admin can tell "Location OFF" from "standing still".
const STATE_INTERVAL_MS = 2 * 60 * 1000;
let stateTimer: ReturnType<typeof setInterval> | null = null;
let onVisible: (() => void) | null = null;

// Best-effort battery percentage — the Web Battery API isn't in every
// WebView, so this silently returns null rather than ever blocking a ping.
async function readBatteryPct(): Promise<number | null> {
  try {
    const nav: any = navigator;
    if (typeof nav.getBattery !== 'function') return null;
    const battery = await nav.getBattery();
    return Math.round(battery.level * 100);
  } catch {
    return null;
  }
}

async function sendPing() {
  if (!latestFix || !currentToken) return;
  const fix = latestFix;
  // Live: the heartbeat timer skips a fix that was already sent, unless the
  // map would otherwise go 30s without hearing from this phone.
  if (mode === 'live' && fix.time === lastSentFixTime && Date.now() - lastSentAt < 30_000) {
    if (Date.now() > liveUntil) void switchMode('active');
    return;
  }
  // Nothing new since the last send (standing still): only a heartbeat — the
  // server stores no duplicate row but still answers "should I go live?".
  const repeat = fix.time === lastSentFixTime;
  const batch = repeat ? [] : pendingFixes.slice();
  lastSentAt = Date.now();
  const battery_pct = await readBatteryPct();
  try {
    const res = await fetch(apiUrl('/api/tracking/ping'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentToken}` },
      body: JSON.stringify({
        lat: fix.latitude,
        lng: fix.longitude,
        accuracy_m: fix.accuracy,
        battery_pct,
        recorded_at: new Date(fix.time).toISOString(),
        repeat,
        mode,
        points: batch.map((f) => ({ lat: f.latitude, lng: f.longitude, accuracy_m: f.accuracy, recorded_at: new Date(f.time).toISOString() }))
      })
    });
    if (res.ok && !repeat) {
      lastSentFixTime = fix.time;
      // Drop what was sent; fixes that arrived meanwhile stay for next time.
      const sentUpTo = batch.length ? batch[batch.length - 1].time : fix.time;
      pendingFixes = pendingFixes.filter((f) => f.time > sentUpTo);
    }
    const data = await res.json().catch(() => null);
    if (data && 'live_until' in data) setLiveUntil(data.live_until);
  } catch {
    // Offline or server unreachable — the fixes stay queued and go out with
    // the next successful send, so a tunnel or dead zone leaves no gap in the path.
  }
}

// Tells the server what this phone says about location (works with no fix).
async function sendState() {
  if (!currentToken) return;
  const access = await getLocationAccess();
  const battery_pct = await readBatteryPct();
  try {
    await fetch(apiUrl('/api/tracking/state'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentToken}` },
      body: JSON.stringify({
        location_on: access ? access.locationOn : null,
        foreground: access ? access.foreground : null,
        background: access ? access.background : null,
        precise: access ? access.precise : null,
        mode,
        battery_pct
      })
    });
  } catch {
    // Offline — the next heartbeat tries again.
  }
}

function restartPingTimer(intervalMs: number) {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(sendPing, intervalMs);
}

// Tears down and re-arms the watcher with the given distanceFilter. Used
// both for the initial start and for switching between active/idle mode —
// the plugin has no way to change distanceFilter on a live watcher, so a
// remove+add is the only option.
async function armWatcher(distanceFilterM: number): Promise<void> {
  if (watcherId) {
    try {
      await BackgroundGeolocation.removeWatcher({ id: watcherId });
    } catch {
      // Already gone — fine, we're about to replace it anyway.
    }
    watcherId = null;
  }
  watcherId = await BackgroundGeolocation.addWatcher(
    {
      backgroundTitle: 'Employee Tracking active',
      backgroundMessage: 'Reporting your location for Employee Tracking. Tap to open the app.',
      requestPermissions: true,
      stale: false,
      distanceFilter: distanceFilterM
    },
    (location, error) => {
      if (!location) {
        // Permission taken away or Location switched off — say so at once
        // instead of waiting for the next heartbeat.
        if (error) void sendState();
        return;
      }
      latestFix = location;
      lastFixAt = Date.now();
      pendingFixes.push(location);
      if (pendingFixes.length > MAX_PENDING_FIXES) pendingFixes = pendingFixes.slice(-MAX_PENDING_FIXES);
      if (mode === 'live' && Date.now() - lastSentAt >= LIVE_MIN_GAP_MS) void sendPing();
      // A fix arrived while idle => the device moved past the coarse
      // threshold, i.e. it's moving again. Snap back to active mode so we
      // don't miss the rest of the movement.
      if (mode === 'idle') void switchMode('active');
    }
  );
}

async function switchMode(next: 'active' | 'idle' | 'live') {
  if (mode === next || switchingMode || !currentToken) return;
  switchingMode = true;
  try {
    mode = next;
    await armWatcher(next === 'live' ? LIVE_DISTANCE_FILTER_M : next === 'active' ? ACTIVE_DISTANCE_FILTER_M : IDLE_DISTANCE_FILTER_M);
    restartPingTimer(next === 'live' ? LIVE_PING_INTERVAL_MS : next === 'active' ? ACTIVE_PING_INTERVAL_MS : IDLE_PING_INTERVAL_MS);
    if (next === 'live') void sendPing();
  } catch {
    // Re-arming failed (permission revoked mid-session, plugin hiccup) —
    // leave whatever watcher/timer state we had; the next idle-check tick
    // or app restart will retry.
  } finally {
    switchingMode = false;
  }
}

// Call once right after login (and again if can_use_tracking is granted
// mid-session — see UserPanel.tsx) with the account's JWT. No-ops on the web
// build or if tracking is already running for this token.
export async function startBackgroundTracking(token: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  // Android only — the iPhone app is built without the background-location
  // plugin (capacitor.config.ts -> ios.includePlugins).
  if (Capacitor.getPlatform() === 'ios') return;
  requestedToken = token;
  // Never ask Android for location before the person has agreed on the
  // disclosure screen (src/lib/locationDisclosure.tsx — a Google Play rule).
  if (getLocationConsent() !== 'accepted') return;
  if (watcherId && currentToken === token) return; // already running for this account
  if (watcherId) await stopBackgroundTracking();

  currentToken = token;
  mode = 'active';
  lastFixAt = Date.now();
  try {
    await armWatcher(ACTIVE_DISTANCE_FILTER_M);
    restartPingTimer(ACTIVE_PING_INTERVAL_MS);
    void sendState();
    if (stateTimer) clearInterval(stateTimer);
    stateTimer = setInterval(() => void sendState(), STATE_INTERVAL_MS);
    // Back to the front (e.g. after turning Location on in Settings): report at once.
    if (onVisible) document.removeEventListener('visibilitychange', onVisible);
    onVisible = () => {
      if (document.visibilityState === 'visible') void sendState();
    };
    document.addEventListener('visibilitychange', onVisible);
    // Checks every minute whether we've gone quiet long enough to drop into
    // idle mode. Cheap (just a Date.now() comparison), so this itself costs
    // no meaningful battery.
    idleCheckTimer = setInterval(() => {
      if (mode === 'live' && Date.now() > liveUntil) void switchMode('active');
      else if (mode === 'active' && Date.now() - lastFixAt >= IDLE_AFTER_MS) {
        void switchMode('idle');
      }
    }, 60 * 1000);
  } catch {
    // Permission denied or plugin unavailable — Employee Tracking simply
    // won't report for this session; every other feature keeps working.
    currentToken = null;
  }
}

// Call on logout, or if an Admin revokes can_use_tracking mid-session.
export async function stopBackgroundTracking(): Promise<void> {
  if (idleCheckTimer) {
    clearInterval(idleCheckTimer);
    idleCheckTimer = null;
  }
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (watcherId) {
    try {
      await BackgroundGeolocation.removeWatcher({ id: watcherId });
    } catch {
      // Already removed / plugin unavailable — nothing left to clean up.
    }
    watcherId = null;
  }
  if (stateTimer) {
    clearInterval(stateTimer);
    stateTimer = null;
  }
  if (onVisible) {
    document.removeEventListener('visibilitychange', onVisible);
    onVisible = null;
  }
  pendingFixes = [];
  lastSentFixTime = 0;
  latestFix = null;
  currentToken = null;
  requestedToken = null;
  mode = 'active';
  liveUntil = 0;
}

// Live Follow: the server says this phone should report every few seconds
// until `until` (ms since epoch), or stop (null/past). Safe to call any time;
// a no-op when tracking isn't running on this device.
export function setLiveUntil(until: number | null | undefined): void {
  liveUntil = Number(until) || 0;
  if (!watcherId || !currentToken) return;
  if (liveUntil > Date.now()) {
    if (mode !== 'live') void switchMode('live');
  } else if (mode === 'live') {
    void switchMode('active');
  }
}

// Restarts tracking for the signed-in account after the set-up card got
// "Allow all the time". No-op when tracking isn't on for this account.
export async function restartBackgroundTracking(): Promise<void> {
  const token = requestedToken;
  if (!token) return;
  await stopBackgroundTracking();
  await startBackgroundTracking(token);
}

// Opens this app's own page in the phone's Settings (Permissions -> Location),
// for the Employee Tracking set-up card. Android app only; false elsewhere.
export async function openAppLocationSettings(): Promise<boolean> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return false;
  try {
    await BackgroundGeolocation.openSettings();
    return true;
  } catch {
    return false;
  }
}

// Location access (LocationAccessPlugin.java, Android app only).
export interface LocationAccessStatus {
  foreground: boolean; // any location permission ("While using the app")
  background: boolean; // "Allow all the time"
  precise: boolean;
  locationOn: boolean; // the phone's Location (GPS) switch
}

interface LocationAccessPlugin {
  getStatus(): Promise<LocationAccessStatus>;
  requestForeground(): Promise<LocationAccessStatus>;
  requestBackground(): Promise<LocationAccessStatus>;
  openAppSettings(): Promise<void>;
  openLocationSettings(): Promise<void>;
}

const LocationAccess = registerPlugin<LocationAccessPlugin>('LocationAccess');

const isAndroidApp = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

// null on the web/iPhone, or on an APK built before the plugin existed.
export async function getLocationAccess(): Promise<LocationAccessStatus | null> {
  if (!isAndroidApp()) return null;
  try {
    return await LocationAccess.getStatus();
  } catch {
    return null;
  }
}

// Android answers at once, showing nothing, when the person has refused
// this permission too often; then the only way left is the App info page.
const NO_PROMPT_MS = 700;

async function requestOrOpenSettings(
  request: () => Promise<LocationAccessStatus>,
  done: (s: LocationAccessStatus) => boolean
): Promise<{ status: LocationAccessStatus; openedSettings: boolean }> {
  const startedAt = Date.now();
  const status = await request();
  if (!done(status) && Date.now() - startedAt < NO_PROMPT_MS) {
    await LocationAccess.openAppSettings();
    return { status, openedSettings: true };
  }
  return { status, openedSettings: false };
}

// Step 1: the in-app dialog ("While using the app").
export const requestForegroundLocation = () =>
  requestOrOpenSettings(() => LocationAccess.requestForeground(), (s) => s.foreground);

// Step 2: opens CredenceHR's Location permission page ("Allow all the time").
export const requestAllTheTimeLocation = () =>
  requestOrOpenSettings(() => LocationAccess.requestBackground(), (s) => s.background);

export async function openPhoneLocationSwitch(): Promise<void> {
  await LocationAccess.openLocationSettings();
}

export function isBackgroundTrackingActive(): boolean {
  return watcherId !== null;
}
