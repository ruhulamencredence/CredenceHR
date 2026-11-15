/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The page's side of clientDevice.ts (server): which device this is, for the
// iPhone Home Screen app's own sign-in. It tells the server what it can't see
// (an iPad calls itself a Mac).

import { Capacitor } from '@capacitor/core';

const ua = () => (typeof navigator !== 'undefined' ? navigator.userAgent || '' : '');

export const isNativeApp = () => Capacitor.isNativePlatform();

// iPad Safari reports a Mac; a Mac with a touch screen is an iPad.
export const isTouchMac = () => /Macintosh/i.test(ua()) && typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 1;

export const isAppleMobile = () => /iPhone|iPad|iPod/i.test(ua()) || isTouchMac();

// Opened from the Home Screen (not a Safari tab).
export const isStandalone = () =>
  typeof window !== 'undefined' &&
  (((navigator as any).standalone as boolean | undefined) === true || !!window.matchMedia?.('(display-mode: standalone)').matches);

// Sent with the sign-in: the iPhone / iPad Home Screen app gets its own,
// longer sign-in; touch_device lets the server tell an iPad from a Mac.
export const signInDeviceFields = (): Record<string, any> => {
  if (isNativeApp()) return {};
  return {
    ...(isAppleMobile() && isStandalone() ? { platform: 'pwa' } : {}),
    ...(isTouchMac() ? { touch_device: true } : {})
  };
};
