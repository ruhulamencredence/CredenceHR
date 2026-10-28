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

import { initializeApp, cert, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { sendWebPushToUserIds } from "./WebPushService";

let firebaseApp: App | null | undefined;

export function getFirebaseApp(): App | null {
  if (firebaseApp !== undefined) return firebaseApp;
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!json) {
    console.warn("ℹ️ FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled (everything else works normally).");
    firebaseApp = null;
    return null;
  }
  try {
    firebaseApp = initializeApp({ credential: cert(JSON.parse(json)) });
  } catch (err: any) {
    console.warn("⚠️ Could not initialize Firebase (check FIREBASE_SERVICE_ACCOUNT_JSON) — push notifications disabled: " + err.message);
    firebaseApp = null;
  }
  return firebaseApp;
}

// A data-only, high-priority push: nothing is shown on the phone; it only
// wakes the app (out of Doze, with its socket asleep) so it can act on
// `data` — e.g. Live Follow telling a phone to start reporting. Expires
// after ttlMs if the phone can't be reached by then. Never throws.
export async function sendSilentPushToUserIds(
  queryDB: (sql: string, params?: any[]) => Promise<any>,
  userIds: number[],
  data: Record<string, string>,
  ttlMs = 60_000
): Promise<number> {
  const app = getFirebaseApp();
  if (!app || userIds.length === 0) return 0;
  try {
    const rows = await queryDB(
      `/*unscoped*/ SELECT token FROM chat_push_tokens WHERE platform = 'android' AND user_id IN (${userIds.map(() => "?").join(",")})`,
      userIds
    );
    if (rows.length === 0) return 0;
    const result = await getMessaging(app).sendEachForMulticast({
      tokens: rows.map((r: any) => r.token),
      data,
      android: { priority: "high", ttl: ttlMs }
    });
    return result.successCount;
  } catch (err: any) {
    console.warn("⚠️ Silent push failed: " + err.message);
    return 0;
  }
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
  // Browsers too (desktop notifications) — with or without Firebase.
  void sendWebPushToUserIds(queryDB, userIds, title, body, data, excludeUserId);
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
    const result = await getMessaging(app).sendEachForMulticast({
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
  // Browsers too (desktop notifications) — with or without Firebase.
  // Only members who still have Chat (users.can_use_chat).
  void queryDB(
    "SELECT m.user_id FROM chat_room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? AND (u.role = 'superadmin' OR COALESCE(u.can_use_chat, 1) <> 0)",
    [roomId]
  )
    .then((members: any[]) =>
      sendWebPushToUserIds(
        queryDB,
        (members || []).map((m: any) => Number(m.user_id)),
        title,
        body,
        data,
        excludeUserId
      )
    )
    .catch(() => {});
  const app = getFirebaseApp();
  if (!app) return;
  try {
    const rows = await queryDB(
      `SELECT t.token FROM chat_push_tokens t
       JOIN chat_room_members m ON m.user_id = t.user_id AND m.room_id = ?
       JOIN users u ON u.id = t.user_id
       WHERE t.user_id != ? AND (u.role = 'superadmin' OR COALESCE(u.can_use_chat, 1) <> 0)`,
      [roomId, excludeUserId]
    );
    if (rows.length === 0) return;
    const result = await getMessaging(app).sendEachForMulticast({
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
