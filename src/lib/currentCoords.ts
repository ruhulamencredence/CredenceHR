/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';

// Same geolocation flow AttendanceCard.tsx / AuthScreen.tsx already use:
// Capacitor's plugin on the native Android app build, plain
// navigator.geolocation on the web build.
// The last fix, kept on this device: the map opens right there (rough
// spot) while a fresh fix is taken. Never used as the Check In/Out
// position itself — that is always a fix from getCurrentCoords.
const LAST_FIX_KEY = 'credence_last_fix';
const LAST_FIX_MAX_AGE = 12 * 3600 * 1000;
export function lastKnownCoords(): { latitude: number; longitude: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_FIX_KEY) || 'null');
    if (v && Number.isFinite(v.latitude) && Number.isFinite(v.longitude) && Date.now() - Number(v.at || 0) < LAST_FIX_MAX_AGE) return { latitude: v.latitude, longitude: v.longitude };
  } catch {
    // storage unavailable or bad value
  }
  return null;
}
function rememberFix(c: { latitude: number; longitude: number }) {
  try {
    localStorage.setItem(LAST_FIX_KEY, JSON.stringify({ ...c, at: Date.now() }));
  } catch {
    // storage unavailable
  }
  return c;
}

// A fix the phone took in the last 30 seconds is accepted as is (you are
// still there) — much quicker than waiting for a new satellite fix.
const MAX_FIX_AGE_MS = 30000;

export async function getCurrentCoords(): Promise<{ latitude: number; longitude: number }> {
  if (Capacitor.isNativePlatform()) {
    let status: string;
    try {
      status = (await Geolocation.checkPermissions()).location;
    } catch {
      status = 'prompt';
    }
    if (status !== 'granted') {
      try {
        status = (await Geolocation.requestPermissions()).location;
      } catch {
        throw new Error('Location permission is required for Check In/Out. Please allow location access and try again.');
      }
    }
    if (status !== 'granted') {
      throw new Error('Location permission is required for Check In/Out. Please allow location access and try again.');
    }
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: MAX_FIX_AGE_MS });
    return rememberFix({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
  }

  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser can't access your location."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(rememberFix({ latitude: pos.coords.latitude, longitude: pos.coords.longitude })),
      () => reject(new Error("Couldn't get your location. Please allow location access and try again.")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: MAX_FIX_AGE_MS }
    );
  });
}

