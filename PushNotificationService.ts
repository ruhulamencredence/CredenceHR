/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared Firebase Cloud Messaging (FCM) sender — split out of ChatRoutes.ts
// so Alerts.ts (and anything else later) can send Android push notifications
// too, without each module trying to admin.initializeApp() its own Firebase
// app (the Admin SDK throws "app already exists" the second time that's
// called with the default name). One shared getFirebaseApp() here, reused by
// every caller.
//
// Entirely optional. Set FIREBASE_SERVICE_ACCOUNT_JSON (the full JSON
// contents of a Firebase service account key) to enable; every send call
// below silently no-ops otherwise, so the app works identically with or
// without it. Manual setup this needs, none of which code can do for you:
//   1. Create a Firebase project (console.firebase.google.com), add an
//      Android app to it with this app's applicationId (see
//      android/app/build.gradle), download google-services.json into
//      android/app/.
//   2. Project Settings -> Service Accounts -> Generate new private key —
//      that JSON file's contents go into FIREBASE_SERVICE_ACCOUNT_JSON.
//   3. Rebuild the APK (see src/lib/pushNotifications.ts for the client half).
//
// chat_push_tokens holds one row per (user, device token) — despite the
// table name (it started out Chat-only), it's just user_id/token/platform,
// so every push sender (Chat, Alerts, ...) reuses the same table/registration
// rather than each needing its own.

import admin from "firebase-admin";

let firebaseApp: admin.app.App | null | undefined;

export function getFirebaseApp(): admin.app.App | null {
  if (firebaseApp !== undefined) return firebaseApp;
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!json) {
    console.warn("ℹ️ FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled (everything else works normally).");
    firebaseApp = null;
    return null;
  }
  try {
    firebaseApp = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(json)) });
  } catch (err: any) {
    console.warn("⚠️ Could not initialize Firebase (check FIREBASE_SERVICE_ACCOUNT_JSON) — push notifications disabled: " + err.message);
    firebaseApp = null;
  }
  return firebaseApp;
}

// Sends to every registered device of the given user ids (minus excludeUserId,
// if any) and prunes any token Firebase reports as no-longer-registered
// (app uninstalled/reinstalled without re-registering). Best-effort — never
// throws, so a push failure never affects the action that triggered it.
export async function sendPushToUserIds(
  queryDB: (sql: string, params?: any[]) => Promise<any>,
  userIds: number[],
  title: string,
  body: string,
  data: Record<string, string>,
  excludeUserId?: number
): Promise<void> {
  const app = getFirebaseApp();
  if (!app || userIds.length === 0) return;
  try {
    const targetIds = excludeUserId ? userIds.filter((id) => id !== excludeUserId) : userIds;
    if (targetIds.length === 0) return;
    const rows = await queryDB(
      `SELECT token FROM chat_push_tokens WHERE user_id IN (${targetIds.map(() => "?").join(",")})`,
      targetIds
    );
    if (rows.length === 0) return;
    const result = await admin.messaging(app).sendEachForMulticast({
      tokens: rows.map((r: any) => r.token),
      notification: { title, body },
      data,
      android: { priority: "high" }
    });
    const deadTokens: string[] = [];
    result.responses.forEach((r, i) => {
      if (!r.success && r.error?.code === "messaging/registration-token-not-registered") {
        deadTokens.push(rows[i].token);
      }
    });
    if (deadTokens.length > 0) {
      await queryDB(`DELETE FROM chat_push_tokens WHERE token IN (${deadTokens.map(() => "?").join(",")})`, deadTokens);
    }
  } catch (err: any) {
    console.warn("⚠️ Push send failed: " + err.message);
  }
}

export async function sendPushToRoomMembers(
  queryDB: (sql: string, params?: any[]) => Promise<any>,
  roomId: number,
  excludeUserId: number,
  title: string,
  body: string,
  data: Record<string, string>
): Promise<void> {
  const app = getFirebaseApp();
  if (!app) return;
  try {
    const rows = await queryDB(
      `SELECT t.token FROM chat_push_tokens t
       JOIN chat_room_members m ON m.user_id = t.user_id AND m.room_id = ?
       WHERE t.user_id != ?`,
      [roomId, excludeUserId]
    );
    if (rows.length === 0) return;
    const result = await admin.messaging(app).sendEachForMulticast({
      tokens: rows.map((r: any) => r.token),
      notification: { title, body },
      data,
      android: { priority: "high" }
    });
    const deadTokens: string[] = [];
    result.responses.forEach((r, i) => {
      if (!r.success && r.error?.code === "messaging/registration-token-not-registered") {
        deadTokens.push(rows[i].token);
      }
    });
    if (deadTokens.length > 0) {
      await queryDB(`DELETE FROM chat_push_tokens WHERE token IN (${deadTokens.map(() => "?").join(",")})`, deadTokens);
    }
  } catch (err: any) {
    console.warn("⚠️ Chat push send failed: " + err.message);
  }
}
