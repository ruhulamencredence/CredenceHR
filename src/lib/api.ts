/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Where the backend REST API lives.
//
// On the WEB build, the frontend is served by the same Express server that
// exposes /api/*, so a relative path ("/api/entries") already resolves to the
// right place — no base URL needed, this stays "".
//
// On the ANDROID APK build, the frontend is bundled INSIDE the app (Capacitor
// loads it from a local origin), so a relative "/api/entries" would try to
// call the phone itself, not your backend server. The user enters a Server
// Address on the Sign In screen instead (their PC's LAN IP for same-WiFi use,
// or a real/public IP or domain for use over mobile data) — it's saved here
// and prepended to every API call.
const STORAGE_KEY = 'mpr_api_base_url';

// Turns whatever the user typed ("192.168.0.10:3000", "http://192.168.0.10:3000",
// "https://myserver.com") into a clean "http(s)://host[:port]" base URL with no
// trailing slash. Defaults to http:// when no scheme is given, since a LAN IP
// almost never has a TLS certificate.
export function normalizeApiBase(input: string): string {
  const trimmed = (input || '').trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

export function getApiBase(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setApiBase(rawInput: string): string {
  const normalized = normalizeApiBase(rawInput);
  try {
    if (normalized) localStorage.setItem(STORAGE_KEY, normalized);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage can be unavailable in some embedded WebViews — safe to ignore,
    // it just means the base URL won't persist across app restarts.
  }
  return normalized;
}

// Every API call in the app should be built with this instead of a bare
// "/api/..." string. When no Server Address has been set (the normal case for
// the Web build) it behaves exactly like the relative path did before.
export function apiUrl(path: string): string {
  const base = getApiBase();
  return base ? `${base}${path}` : path;
}
