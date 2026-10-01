/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Push notifications (Android, via Firebase Cloud Messaging) — the
// client-side half of ChatRoutes.ts's notifyNewMessage and Alerts.ts's
// createAlert (see PushNotificationService.ts). No-ops entirely on the web
// build (Capacitor.isNativePlatform() === false) and degrades gracefully
// everywhere else: permission denied, the plugin missing (e.g. a web-only
// checkout), or the request failing all just mean this device won't receive
// pushes — Chat/Alerts themselves keep working normally (Socket.IO/REST)
// whenever the app is actually open.
//
// Requires @capacitor/push-notifications (already in package.json) AND a
// Firebase project wired up on both ends — see FIREBASE_SERVICE_ACCOUNT_JSON
// in .env.example for the manual setup steps (a Firebase console project +
// google-services.json in android/app/), none of which code alone can do.

import { Capacitor } from '@capacitor/core';
import { apiUrl } from './api';

let registeredToken: string | null = null;

// Push notifications need a real Firebase project wired up on the native
// side (android/app/google-services.json — see android/app/build.gradle's
// `servicesJSON = file('google-services.json')` check, which only applies
// the google-services Gradle plugin when that file exists). Without it,
// FirebaseApp is never initialized, and calling PushNotifications.register()
// below throws a NATIVE exception the JS try/catch here can't catch —
// on a build without google-services.json this crashes the whole app the
// instant the OS permission prompt is answered (either Allow or Don't
// allow triggers PushNotifications.register() straight after). Keep this
// false until google-services.json has actually been added (see
// PushNotificationService.ts's setup steps) and the app rebuilt — flipping
// it on before then will crash the APK on first launch.
const PUSH_NOTIFICATIONS_ENABLED = true;

export interface PushTapHandlers {
  // Fires when a Chat push notification is tapped — passes the roomId to
  // open straight to that conversation.
  onChatTap: (roomId: number) => void;
  // Fires when an Alerts push notification is tapped (any alert `type` other
  // than a Chat message, i.e. no roomId in the payload — see Alerts.ts's
  // createAlert, which sends `type`/`relatedType`/`relatedId`).
  onAlertTap: (data: { type: string; relatedType: string; relatedId: string }) => void;
}

// Call once right after login (mirrors connectChatSocket/startBackgroundTracking).
export async function initPushNotifications(token: string, handlers: PushTapHandlers): Promise<void> {
  if (!PUSH_NOTIFICATIONS_ENABLED || !Capacitor.isNativePlatform()) return;
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
      // get pushes; every other Chat/Alerts path (open app, Socket.IO/REST)
      // is unaffected.
    });
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const data = action.notification?.data || {};
      const roomId = Number(data.roomId);
      if (Number.isFinite(roomId)) {
        handlers.onChatTap(roomId);
      } else if (data.type) {
        handlers.onAlertTap({ type: String(data.type), relatedType: String(data.relatedType || ''), relatedId: String(data.relatedId || '') });
      }
    });

    await PushNotifications.register();
  } catch {
    // @capacitor/push-notifications not installed/loadable, or the OS
    // permission prompt was dismissed — Chat/Alerts keep working without push.
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
