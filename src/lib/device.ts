/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Which phone the app is on, sent with the app's sign-in so an account can
// be limited to its own phone (DeviceRoutes.ts). Device.getId() stays the
// same across app reinstalls on Android (per signing key) and iOS
// (identifierForVendor, while any app from us stays installed).

import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';

export async function appDeviceInfo(): Promise<{ device_id: string; device_name: string; device_platform: string } | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const [{ identifier }, info] = await Promise.all([Device.getId(), Device.getInfo()]);
    const maker = info.manufacturer && !String(info.model || '').toLowerCase().startsWith(info.manufacturer.toLowerCase()) ? `${info.manufacturer} ` : '';
    const os = info.platform === 'ios' ? 'iOS' : info.platform === 'android' ? 'Android' : info.platform;
    return {
      device_id: identifier,
      device_name: `${info.name && info.platform === 'ios' ? info.name : `${maker}${info.model || 'Phone'}`} · ${os} ${info.osVersion || ''}`.trim(),
      device_platform: info.platform
    };
  } catch {
    return null;
  }
}

// Why the app last signed out on its own (shown on the sign-in screen).
const REASON_KEY = 'credence_signed_out_reason';
export function setSignedOutReason(text: string) {
  try {
    sessionStorage.setItem(REASON_KEY, text);
  } catch {}
}
export function takeSignedOutReason(): string {
  try {
    const v = sessionStorage.getItem(REASON_KEY) || '';
    sessionStorage.removeItem(REASON_KEY);
    return v;
  } catch {
    return '';
  }
}
export const DEVICE_REVOKED_EVENT = 'credence:device-revoked';
