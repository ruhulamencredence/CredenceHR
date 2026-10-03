/*
 * CredenceHR desktop notifications (Web Push) — see src/lib/webPush.ts and
 * WebPushService.ts. Shows each push as a system notification, even with the
 * CredenceHR tab closed; clicking it brings CredenceHR forward (or opens it)
 * on that chat or on Alerts.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch (e) {
    msg = { body: event.data ? event.data.text() : '' };
  }
  const title = msg.title || 'CredenceHR';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: msg.body || '',
      icon: '/favicon.png',
      badge: '/favicon.png',
      tag: msg.tag || undefined,
      renotify: !!msg.tag,
      data: msg.data || {}
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          client.postMessage({ type: 'credence-push-open', data });
          return;
        }
      }
      const query = data.roomId
        ? `?open=chat&room=${encodeURIComponent(data.roomId)}`
        : data.type === 'notice'
          ? '?open=notice'
          : '?open=alerts';
      await self.clients.openWindow('/' + query);
    })()
  );
});
