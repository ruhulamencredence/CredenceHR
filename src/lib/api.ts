/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Where the backend REST API lives.
//
// Both the WEB build and the ANDROID APK build are served the SAME way now:
// Capacitor's WebView is pointed straight at a real server URL (see
// capacitor.config.ts's `server.url` — NOT the older "bundle the frontend
// inside the APK" mode). That means the app — UI shell, JS, and every
// relative "/api/..." call — always resolves against whichever single
// origin it was loaded from, on both platforms, with zero base-URL
// bookkeeping needed here.
//
export function apiUrl(path: string): string {
  return path;
}

// De-dupes identical concurrent authenticated GETs. UserPanel's Dashboard
// mounts several cards (AttendanceCard, LeaveSummaryCard,
// PendingApprovalsCard, HolidayCalendarWidget) TWICE on every load — once
// for the mobile layout, once for the md+ desktop grid, toggled visible via
// CSS rather than actually swapping which copy is in the DOM (so both are
// always mounted, whichever viewport is active) — so each card's own fetch
// on mount would otherwise fire twice, doubling the Dashboard's network
// calls for no benefit. Both callers here get the exact same in-flight
// promise/result instead; the entry is dropped once it settles, so a later
// genuine reload (a manual refresh, a token change, ...) still hits the
// network fresh rather than ever serving stale data.
//
// Caches the PARSED JSON (a plain value), not the raw Response — a raw
// fetch Response's body can only be read once, so handing the same Response
// to two callers would need response.clone() timed exactly right; caching
// the already-awaited JSON sidesteps that entirely.
const inFlightJsonRequests = new Map<string, Promise<any>>();

export function dedupedFetchJson(url: string, token: string): Promise<any> {
  const key = `${token}::${url}`;
  const existing = inFlightJsonRequests.get(key);
  if (existing) return existing;
  const promise = fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null)
    .finally(() => {
      inFlightJsonRequests.delete(key);
    });
  inFlightJsonRequests.set(key, promise);
  return promise;
}