/*
 * CredenceHR desktop notifications (Web Push) — see src/lib/webPush.ts and
 * WebPushService.ts. Shows each push as a system notification, even with the
 * CredenceHR tab closed; clicking it brings CredenceHR forward (or opens it)
 * on that chat or on Alerts.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/*
 * Map tiles (OpenStreetMap) kept on the device once seen, so a place opened
 * before — the office, a site — draws at once and costs no data next time.
 * Only tiles actually viewed are kept (never a bulk download: OSM's tile
 * policy forbids it), at most TILE_MAX of them, each for TILE_DAYS days;
 * the oldest go first. Fetched with CORS (OSM allows it), so what is stored
 * is a normal response, not an opaque one that eats storage quota.
 */
const TILE_CACHE = 'map-tiles-v1';
const TILE_MAX = 600;
const TILE_DAYS = 30;
const isTile = (url) => url.hostname.endsWith('tile.openstreetmap.org') && /\/\d+\/\d+\/\d+\.png$/.test(url.pathname);

async function trimTiles(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - TILE_MAX; i++) await cache.delete(keys[i]);
}

async function tile(request) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(request.url);
  if (hit) {
    const at = Number(hit.headers.get('x-saved-at') || 0);
    if (Date.now() - at < TILE_DAYS * 86400000) return hit;
  }
  try {
    const res = await fetch(new Request(request.url, { mode: 'cors', credentials: 'omit' }));
    if (res.ok) {
      const body = await res.clone().blob();
      const headers = new Headers(res.headers);
      headers.set('x-saved-at', String(Date.now()));
      await cache.put(request.url, new Response(body, { status: 200, headers }));
      trimTiles(cache).catch(() => {});
    }
    return res;
  } catch (e) {
    // Offline: an older copy is better than a blank square.
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  let url;
  try {
    url = new URL(event.request.url);
  } catch (e) {
    return;
  }
  if (isTile(url)) event.respondWith(tile(event.request));
});

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
