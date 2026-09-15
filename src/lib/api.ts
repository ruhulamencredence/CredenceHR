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
// Switching an Android device to a DIFFERENT deployment (see GlobalSidebar's
// "Set Server" -> ServerSwitcherModal.tsx, fed by the catalog a Superadmin
// manages from the WEB Admin Panel -> Servers / ServerProfileRoutes.ts) is a
// full page navigation (window.location.href = thatServer'sUrl) — the
// WebView just loads that other server's app fresh, exactly like opening a
// different website, rather than this file quietly redirecting only SOME
// fetch() calls to a different origin than the one the page (and everything
// on it — login, assets, everything) actually came from. That split — UI
// from server A, API calls from server B — was the earlier design here and
// is exactly what caused "switching doesn't actually switch" confusion.
export function apiUrl(path: string): string {
  return path;
}
