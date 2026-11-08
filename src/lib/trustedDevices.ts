/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Trusted-device tokens for the sign-in page (server: LoginGuard.ts). After a
// successful password sign-in the server hands this phone / browser a signed
// token for that account; it is sent back with the next sign-in so the
// account / office-network lock (someone else's wrong passwords) doesn't
// keep this device out. One per account, newest first, at most 10. Kept on
// purpose across sign-out (that is when it's needed); the server stops
// accepting one once the account's password changes. Storage missing: the
// sign-in just works as before.

const KEY = 'chr_login_devices';
const MAX = 10;

interface Entry {
  u: number;
  t: string;
}

function read(): Entry[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((e) => e && typeof e.t === 'string' && Number.isFinite(Number(e.u))) : [];
  } catch {
    return [];
  }
}

// Tokens to send with a sign-in (the server picks the one for that account).
export function trustedDeviceTokens(): string[] {
  return read().map((e) => e.t).slice(0, MAX);
}

export function saveTrustedDevice(userId: unknown, token: unknown): void {
  const u = Number(userId);
  if (!Number.isFinite(u) || u <= 0 || typeof token !== 'string' || !token) return;
  try {
    const rest = read().filter((e) => Number(e.u) !== u);
    localStorage.setItem(KEY, JSON.stringify([{ u, t: token }, ...rest].slice(0, MAX)));
  } catch {
    // full / unavailable — no trusted device this time
  }
}
