/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

// Remote Attendance Check In / Out on the Android app: one fresh position
// from the APK (LocationAccessPlugin.getCurrentFix) together with whether it
// came from a mock-location ("fake GPS") app — Capacitor's Geolocation
// plugin can't tell. The server refuses a mock fix
// (POST /api/attendance/check-in / check-out).
//
// null = no answer of this kind here (the web, or an APK from before this
// method): the caller then takes the position the usual way, unchecked.
export interface AttendanceFix {
  latitude: number;
  longitude: number;
  accuracy?: number;
  mock?: boolean;
}

interface FixPlugin {
  getCurrentFix(opts: { maxAgeMs: number; timeoutMs: number }): Promise<{ latitude: number; longitude: number; accuracy?: number; mock?: boolean }>;
}
const LocationAccess = registerPlugin<FixPlugin>('LocationAccess');

export async function nativeAttendanceFix(): Promise<AttendanceFix | null> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return null;
  try {
    const f = await LocationAccess.getCurrentFix({ maxAgeMs: 30000, timeoutMs: 15000 });
    if (!Number.isFinite(f?.latitude) || !Number.isFinite(f?.longitude)) return null;
    return { latitude: f.latitude, longitude: f.longitude, accuracy: f.accuracy, mock: f.mock === true };
  } catch (e: any) {
    // Older APK without the method: fall back quietly.
    if (e?.code === 'UNIMPLEMENTED' || /not implemented/i.test(String(e?.message || ''))) return null;
    throw new Error(e?.message || "Couldn't get your location. Please try again.");
  }
}

export const MOCK_LOCATION_MESSAGE =
  'Fake GPS is on on this phone (a mock-location app). Turn it off — and in Developer options set "Select mock location app" to Nothing — then try again.';
