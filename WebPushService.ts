/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Desktop/browser notifications (Web Push) — the website's counterpart of the
// app's Firebase pushes (PushNotificationService.ts calls into here, so every
// chat message and alert that pushes to a phone also reaches the browsers an
// account turned notifications on in). They arrive even with the CredenceHR
// tab closed, as long as the browser is running. Browsers only allow this on
// an HTTPS address (or localhost).
//
// No Firebase needed: the server's own VAPID key pair signs each push. It is
// made once and kept in web_push_keys (WEB_PUSH_PUBLIC_KEY /
// WEB_PUSH_PRIVATE_KEY in .env take precedence), so subscriptions stay valid
// across restarts. src/lib/webPush.ts + public/sw.js are the browser half.

import type { Express } from "express";
import webpush from "web-push";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

let keys: { publicKey: string; privateKey: string } | null = null;
let ready = false;

export async function ensureWebPushSchema(queryDB: QueryDB) {
  await queryDB(`CREATE TABLE IF NOT EXISTS web_push_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    endpoint VARCHAR(700) NOT NULL,
    p256dh VARCHAR(255) NOT NULL,
    auth VARCHAR(100) NOT NULL,
    user_agent VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP NULL,
    UNIQUE KEY uniq_web_push_endpoint (endpoint),
    KEY idx_web_push_user (user_id)
  )`);
  await queryDB(`CREATE TABLE IF NOT EXISTS web_push_keys (
    id INT PRIMARY KEY,
    public_key VARCHAR(255) NOT NULL,
    private_key VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await loadKeys(queryDB);
}

async function loadKeys(queryDB: QueryDB) {
  if (process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY) {
    keys = { publicKey: process.env.WEB_PUSH_PUBLIC_KEY, privateKey: process.env.WEB_PUSH_PRIVATE_KEY };
  } else {
    const rows: any[] = (await queryDB("SELECT public_key, private_key FROM web_push_keys WHERE id = 1")) || [];
    if (rows[0]) keys = { publicKey: rows[0].public_key, privateKey: rows[0].private_key };
    else {
      keys = webpush.generateVAPIDKeys();
      await queryDB("INSERT INTO web_push_keys (id, public_key, private_key) VALUES (1, ?, ?)", [keys.publicKey, keys.privateKey]);
    }
  }
  // The contact address push services may use to reach the sender.
  const contact = process.env.WEB_PUSH_CONTACT || (process.env.ADMIN_EMAIL ? `mailto:${process.env.ADMIN_EMAIL}` : "mailto:admin@example.com");
  webpush.setVapidDetails(contact.includes(":") ? contact : `mailto:${contact}`, keys.publicKey, keys.privateKey);
  ready = true;
}

/** Sends to every browser the given accounts turned notifications on in. Never throws. */
export async function sendWebPushToUserIds(
  queryDB: QueryDB,
  userIds: number[],
  title: string,
  body: string,
  data: Record<string, string>,
  excludeUserId?: number
): Promise<void> {
  if (!ready) return;
  const ids = [...new Set(userIds.map(Number))].filter((id) => id && id !== excludeUserId);
  if (!ids.length) return;
  try {
    const rows: any[] =
      (await queryDB(`SELECT id, endpoint, p256dh, auth FROM web_push_subscriptions WHERE user_id IN (${ids.map(() => "?").join(",")})`, ids)) || [];
    if (!rows.length) return;
    // A chat's notifications replace each other instead of piling up.
    const tag = data.roomId ? `chat-${data.roomId}` : data.relatedType && data.relatedId ? `${data.relatedType}-${data.relatedId}` : undefined;
    const payload = JSON.stringify({ title, body: String(body || "").slice(0, 300), tag, data });
    const gone: number[] = [];
    await Promise.all(
      rows.map(async (r) => {
        try {
          await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload, { TTL: 24 * 60 * 60 });
        } catch (err: any) {
          // 404/410: the browser dropped this subscription.
          if (err?.statusCode === 404 || err?.statusCode === 410) gone.push(Number(r.id));
          else console.warn("⚠️ Web push send failed: " + (err?.body || err?.message || err));
        }
      })
    );
    if (gone.length) await queryDB(`DELETE FROM web_push_subscriptions WHERE id IN (${gone.map(() => "?").join(",")})`, gone);
  } catch (err: any) {
    console.warn("⚠️ Web push failed: " + err.message);
  }
}

export function registerWebPushRoutes(app: Express, deps: { authenticateToken: any; queryDB: QueryDB }) {
  const { authenticateToken, queryDB } = deps;

  app.get("/api/web-push/key", authenticateToken, (_req: any, res) => {
    if (!keys) return res.status(503).json({ error: "Desktop notifications aren't available on this server." });
    res.json({ publicKey: keys.publicKey });
  });

  // A browser of this account turned notifications on (or re-confirms on
  // each sign-in; a browser shared by another account moves to this one).
  app.post("/api/web-push/subscribe", authenticateToken, async (req: any, res) => {
    try {
      const s = req.body?.subscription || {};
      const endpoint = String(s.endpoint || "");
      const p256dh = String(s.keys?.p256dh || "");
      const auth = String(s.keys?.auth || "");
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 700 || !p256dh || !auth) return res.status(400).json({ error: "Invalid subscription." });
      const ua = String(req.headers["user-agent"] || "").slice(0, 255);
      await queryDB(
        `INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, last_used_at) VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth), user_agent = VALUES(user_agent), last_used_at = NOW()`,
        [req.user.id, endpoint, p256dh, auth, ua]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Signing out / turning notifications off in this browser.
  app.post("/api/web-push/unsubscribe", authenticateToken, async (req: any, res) => {
    try {
      const endpoint = String(req.body?.endpoint || "");
      if (endpoint) await queryDB("DELETE FROM web_push_subscriptions WHERE endpoint = ? AND user_id = ?", [endpoint, req.user.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
