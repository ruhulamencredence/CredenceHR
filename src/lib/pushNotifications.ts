/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Chat push notifications (Android, via Firebase Cloud Messaging) — the
// client-side half of ChatRoutes.ts's notifyNewMessage/chat_push_tokens.
// No-ops entirely on the web build (Capacitor.isNativePlatform() === false)
// and degrades gracefully everywhere else: permission denied, the plugin
// missing (e.g. a web-only checkout), or the request failing all just mean
// this device won't receive pushes — Chat itself keeps working normally
// over Socket.IO/REST whenever the app is actually open.
//
// Requires @capacitor/push-notifications (already in package.json) AND a
// Firebase project wired up on both ends — see FIREBASE_SERVICE_ACCOUNT_JSON
// in .env.example for the manual setup steps (a Firebase console project +
// google-services.json in android/app/), none of which code alone can do.

import { Capacitor } from '@capacitor/core';
import { apiUrl } from './api';

let registeredToken: string | null = null;

// Call once right after login (mirrors connectChatSocket/startBackgroundTracking).
// onNotificationTap fires when the account taps a Chat push notification
// while the app was backgrounded/closed — passes the roomId to open straight
// to that conversation instead of just landing on whatever screen was last open.
export async function initPushNotifications(token: string, onNotificationTap: (roomId: number) => void): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    let permStatus = await PushNotifications.checkPermissions();
    if (permStatus.receive === 'prompt') {
      permStatus = await PushNotifications.requestPermissions();
    }
    if (permStatus.receive !== 'granted') return;

    // Re-registering listeners on every call (e.g. a token refresh mid-
    // session) would otherwise stack duplicate handlers — clear first.
    await PushNotifications.removeAllListeners();

    PushNotifications.addListener('registration', (result) => {
      registeredToken = result.value;
      fetch(apiUrl('/api/chat/push-token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ token: result.value, platform: 'android' })
      }).catch(() => {
        // Offline right at registration — the next app open/token refresh retries.
      });
    });
    PushNotifications.addListener('registrationError', () => {
      // Device/Firebase-side registration failed — this device simply won't
      // get pushes; every other Chat path (open app, Socket.IO) is unaffected.
    });
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const roomId = Number(action.notification?.data?.roomId);
      if (Number.isFinite(roomId)) onNotificationTap(roomId);
    });

    await PushNotifications.register();
  } catch {
    // @capacitor/push-notifications not installed/loadable, or the OS
    // permission prompt was dismissed — Chat keeps working without push.
  }
}

// Call on logout so a shared/reused device stops receiving this account's
// pushes once signed out (see DELETE /api/chat/push-token).
export async function clearPushToken(token: string): Promise<void> {
  if (!registeredToken || !Capacitor.isNativePlatform()) return;
  try {
    await fetch(apiUrl('/api/chat/push-token'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ token: registeredToken })
    });
  } catch {
    // Offline at logout — the token row just goes stale server-side
    // (harmless: one dead row, cleaned up automatically the next time a push
    // to it comes back "not registered" — see sendPushToRoomMembers).
  } finally {
    registeredToken = null;
  }
}
