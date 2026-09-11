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
// Design: the watcher's callback can fire far more often than we want to hit
// the network (every GPS fix, potentially every few seconds), so we DON'T
// send a request from inside it. Instead we just remember the latest fix in
// memory, and a separate timer (PING_INTERVAL_MS) POSTs whatever the latest
// fix is every 5-10 minutes. This decouples "how often the OS reports a GPS
// fix" from "how often we hit the server", which is what actually matters for
// battery/data usage.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { apiUrl } from './api';

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

// Midpoint of the 5-10 minute range the person asked for — one ping every 7
// minutes, whichever fix happens to be freshest at that moment.
const PING_INTERVAL_MS = 7 * 60 * 1000;

let watcherId: string | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let latestFix: BGLocation | null = null;
let currentToken: string | null = null;

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
  const battery_pct = await readBatteryPct();
  try {
    await fetch(apiUrl('/api/tracking/ping'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentToken}` },
      body: JSON.stringify({
        lat: latestFix.latitude,
        lng: latestFix.longitude,
        accuracy_m: latestFix.accuracy,
        battery_pct,
        recorded_at: new Date(latestFix.time).toISOString()
      })
    });
  } catch {
    // Offline or server unreachable — just skip this cycle. The next timer
    // tick (or the next time the app reconnects) will try again with
    // whatever fix is freshest then; we don't queue/retry missed pings.
  }
}

// Call once right after login (and again if can_use_tracking is granted
// mid-session — see UserPanel.tsx) with the account's JWT. No-ops on the web
// build or if tracking is already running for this token.
export async function startBackgroundTracking(token: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (watcherId && currentToken === token) return; // already running for this account
  if (watcherId) await stopBackgroundTracking();

  currentToken = token;
  try {
    watcherId = await BackgroundGeolocation.addWatcher(
      {
        backgroundTitle: 'Employee Tracking active',
        backgroundMessage: 'Reporting your location for Employee Tracking. Tap to open the app.',
        requestPermissions: true,
        stale: false,
        distanceFilter: 0
      },
      (location) => {
        if (location) latestFix = location;
      }
    );
    pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
  } catch {
    // Permission denied or plugin unavailable — Employee Tracking simply
    // won't report for this session; every other feature keeps working.
    currentToken = null;
  }
}

// Call on logout, or if an Admin revokes can_use_tracking mid-session.
export async function stopBackgroundTracking(): Promise<void> {
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
  latestFix = null;
  currentToken = null;
}

export function isBackgroundTrackingActive(): boolean {
  return watcherId !== null;
}
