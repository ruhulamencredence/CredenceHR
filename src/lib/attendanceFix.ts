/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Capacitor, registerPlugin } from '@capacitor/core';
import { useEffect } from 'react';

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
  // Keeps the phone's GPS awake for a minute at most (it stops itself), so the
  // reading taken on these screens is a GPS fix, not a Wi-Fi / tower guess.
  warmUp(opts: { durationMs: number }): Promise<void>;
  stopWarm(): Promise<void>;
}
const LocationAccess = registerPlugin<FixPlugin>('LocationAccess');

export async function nativeAttendanceFix(maxAgeMs = 5000): Promise<AttendanceFix | null> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return null;
  try {
    const f = await LocationAccess.getCurrentFix({ maxAgeMs, timeoutMs: 15000 });
    if (!Number.isFinite(f?.latitude) || !Number.isFinite(f?.longitude)) return null;
    return { latitude: f.latitude, longitude: f.longitude, accuracy: f.accuracy, mock: f.mock === true };
  } catch (e: any) {
    // Older APK without the method: fall back quietly.
    if (e?.code === 'UNIMPLEMENTED' || /not implemented/i.test(String(e?.message || ''))) return null;
    throw new Error(e?.message || "Couldn't get your location. Please try again.");
  }
}

// A fix this close (metres, the phone's own accuracy estimate) is trusted for
// the attendance area; a coarser one (cell towers / Wi-Fi, often hundreds of
// metres off) is refined first — see AttendanceMapConfirm.tsx.
export const GOOD_ACCURACY_M = 30;
// Worse than this is a Wi-Fi / mobile-tower guess, not GPS — the same line
// the phone's tracking draws (DutyTrackingService ROUGH_M, trackPath.ts).
export const ROUGH_ACCURACY_M = 100;

export type FixQuality = 'good' | 'fair' | 'weak' | 'unknown';
export function fixQuality(accuracy?: number | null): FixQuality {
  if (accuracy == null || !Number.isFinite(Number(accuracy))) return 'unknown';
  const a = Number(accuracy);
  return a <= GOOD_ACCURACY_M ? 'good' : a <= ROUGH_ACCURACY_M ? 'fair' : 'weak';
}

// In the Android app a weak fix is not accepted for Remote Attendance or
// Check In/Out (the phone has real GPS: wait for it, or step outside). A
// browser / desktop often has no GPS at all, so there a weak fix may go — with
// the warning. The accuracy is stored either way (attendance / claims
// check_in_accuracy_m, check_out_accuracy_m).
export const isAndroidApp = (): boolean => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
export const weakFixBlocks = (accuracy?: number | null): boolean => isAndroidApp() && fixQuality(accuracy) === 'weak';
// How long the screens keep asking for a better fix.
export const refineWindowMs = (): number => (isAndroidApp() ? 40000 : 15000);

export const weakFixText = (accuracy: number): string => `GPS is only ±${Math.round(accuracy)} m — this position may be wrong. Step near a window or outside, turn on Wi-Fi, then tap ⊙`;

// The Android app is asked to keep GPS awake while a screen that needs a fix
// is open (warmUp stops by itself after a minute; stopWarmGps ends it sooner).
// An older APK without the methods just answers "not implemented".
let warming = false;
export async function warmUpGps(): Promise<void> {
  if (!isAndroidApp()) return;
  warming = true;
  try {
    await LocationAccess.warmUp({ durationMs: 45000 });
  } catch {
    // older APK / no permission yet: the readings still work, just colder
  }
}
export async function stopWarmGps(): Promise<void> {
  if (!warming) return;
  warming = false;
  try {
    await LocationAccess.stopWarm();
  } catch {
    // nothing to stop
  }
}
// For a screen that is only open while it is on view (the Check In/Out map).
export function useGpsWarm(): void {
  useEffect(() => {
    void warmUpGps();
    return () => void stopWarmGps();
  }, []);
}

export const MOCK_LOCATION_MESSAGE =
  'Fake GPS is on on this phone (a mock-location app). Turn it off — and in Developer options set "Select mock location app" to Nothing — then try again.';
