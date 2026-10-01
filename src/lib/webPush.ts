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

async function subscribeAndSave(token: string): Promise<boolean> {
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const res = await fetch(apiUrl('/api/web-push/key'), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return false;
    const { publicKey } = await res.json();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
  }
  const saved = await fetch(apiUrl('/api/web-push/subscribe'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ subscription: sub.toJSON() })
  });
  return saved.ok;
}

/** Asks the browser for permission (needs a click) and turns notifications on. */
export async function enableWebPush(token: string): Promise<'granted' | 'denied' | 'default' | 'unsupported' | 'failed'> {
  if (!webPushSupported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;
  try {
    return (await subscribeAndSave(token)) ? 'granted' : 'failed';
  } catch {
    return 'failed';
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
 * public/sw.js; a new tab opens with ?open=chat&room=… or ?open=alerts.
 */
export function listenWebPushOpens(onOpen: (d: WebPushOpen) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  try {
    const q = new URLSearchParams(window.location.search);
    const open = q.get('open');
    if (open === 'chat' || open === 'alerts') {
      onOpen(open === 'chat' ? { roomId: q.get('room') || undefined } : {});
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
