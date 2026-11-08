/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Desktop notifications on the website (Web Push) — the browser half of
// WebPushService.ts; public/sw.js shows them. The app (APK) has its own
// Firebase pushes (pushNotifications.ts), so this is website only. Browsers
// allow it only on HTTPS or localhost (window.isSecureContext).

import { Capacitor } from '@capacitor/core';
import { apiUrl } from './api';

export function webPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    !Capacitor.isNativePlatform() &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function webPushPermission(): NotificationPermission | 'unsupported' {
  return webPushSupported() ? Notification.permission : 'unsupported';
}

function keyBytes(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// A step that never answers (a blocked network, a stuck worker) fails
// instead of leaving the "Turn on" button spinning forever.
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(what)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

// Reasons shown to the person when turning on fails.
export const WEB_PUSH_STEP = {
  worker: "The notification helper (sw.js) didn't load. Reload the page and try again.",
  key: "Couldn't reach the CredenceHR server. Try again.",
  subscribe:
    "The browser couldn't reach its notification service (Google/Microsoft). The office network or a firewall may be blocking it — try again on another network, or ask IT to allow fcm.googleapis.com.",
  save: "Couldn't save this browser on the server. Try again."
};

async function subscribeAndSave(token: string): Promise<void> {
  let reg: ServiceWorkerRegistration;
  try {
    reg = await withTimeout(navigator.serviceWorker.register('/sw.js'), 15000, WEB_PUSH_STEP.worker);
    await withTimeout(navigator.serviceWorker.ready, 15000, WEB_PUSH_STEP.worker);
  } catch {
    throw new Error(WEB_PUSH_STEP.worker);
  }
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    let publicKey = '';
    try {
      const res = await withTimeout(fetch(apiUrl('/api/web-push/key'), { headers: { Authorization: `Bearer ${token}` } }), 15000, WEB_PUSH_STEP.key);
      if (!res.ok) throw new Error(WEB_PUSH_STEP.key);
      publicKey = (await res.json()).publicKey;
    } catch {
      throw new Error(WEB_PUSH_STEP.key);
    }
    try {
      sub = await withTimeout(
        reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource }),
        20000,
        WEB_PUSH_STEP.subscribe
      );
    } catch {
      throw new Error(WEB_PUSH_STEP.subscribe);
    }
  }
  let ok = false;
  try {
    const saved = await withTimeout(
      fetch(apiUrl('/api/web-push/subscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ subscription: sub.toJSON() })
      }),
      15000,
      WEB_PUSH_STEP.save
    );
    ok = saved.ok;
  } catch {}
  if (!ok) throw new Error(WEB_PUSH_STEP.save);
}

export type WebPushResult =
  | { status: 'granted' }
  | { status: 'denied' | 'default' | 'unsupported' }
  | { status: 'failed'; reason: string };

/**
 * Asks the browser for permission (needs a click) and turns notifications on.
 * onWaiting fires if the browser's own prompt hasn't been answered after a few
 * seconds — Chrome often shows it only as a small bell in the address bar.
 */
export async function enableWebPush(token: string, onWaiting?: () => void): Promise<WebPushResult> {
  if (!webPushSupported()) return { status: 'unsupported' };
  let permission: NotificationPermission = Notification.permission;
  if (permission === 'default') {
    const hint = setTimeout(() => onWaiting?.(), 4000);
    try {
      permission = await Notification.requestPermission();
    } finally {
      clearTimeout(hint);
    }
  }
  if (permission !== 'granted') return { status: permission };
  try {
    await subscribeAndSave(token);
    return { status: 'granted' };
  } catch (e: any) {
    return { status: 'failed', reason: e?.message || WEB_PUSH_STEP.subscribe };
  }
}

/** After sign-in: if this browser already allowed notifications, tie it to this account. */
export async function syncWebPush(token: string): Promise<void> {
  if (!webPushSupported() || Notification.permission !== 'granted') return;
  try {
    await subscribeAndSave(token);
  } catch {
    // Offline or blocked — the next sign-in tries again.
  }
}

/** On sign-out: this browser stops receiving the account's notifications. */
export async function disableWebPush(token: string | null): Promise<void> {
  if (!webPushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    if (token)
      await fetch(apiUrl('/api/web-push/unsubscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ endpoint: sub.endpoint })
      }).catch(() => {});
    await sub.unsubscribe();
  } catch {
    // Nothing to undo.
  }
}

export interface WebPushOpen {
  roomId?: string;
  type?: string;
  relatedType?: string;
  relatedId?: string;
}

/**
 * Clicking a notification: an open CredenceHR tab gets a message from
 * public/sw.js; a new tab opens with ?open=chat&room=…, ?open=notice or ?open=alerts.
 */
export function listenWebPushOpens(onOpen: (d: WebPushOpen) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  try {
    const q = new URLSearchParams(window.location.search);
    const open = q.get('open');
    if (open === 'chat' || open === 'alerts' || open === 'notice') {
      onOpen(open === 'chat' ? { roomId: q.get('room') || undefined } : open === 'notice' ? { type: 'notice' } : {});
      q.delete('open');
      q.delete('room');
      const rest = q.toString();
      window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
    }
  } catch {}
  if (!('serviceWorker' in navigator)) return () => {};
  const onMessage = (e: MessageEvent) => {
    if (e.data?.type === 'credence-push-open') onOpen(e.data.data || {});
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}
