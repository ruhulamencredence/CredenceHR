/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Sign in with fingerprint / face (server: FingerprintRoutes.ts).
//   - App: a secret from the server kept in the phone's hardware store
//     behind the fingerprint (@capgo/capacitor-native-biometric).
//   - Website: a passkey (WebAuthn) — fingerprint, Windows Hello, Touch ID.
// Which account this device signs in to is remembered in localStorage so the
// sign-in screen can offer "Sign in with fingerprint" for it.

import { Capacitor } from '@capacitor/core';
import { apiUrl } from './api';
import { appDeviceInfo } from './device';
import type { User } from '../types';

export const canUseFingerprint = (u?: Pick<User, 'role' | 'can_use_fingerprint' | 'is_onboarding'> | null) =>
  !!u && !u.is_onboarding && (u.role === 'superadmin' || !!u.can_use_fingerprint);

const SERVER = 'credencehr.fingerprint';
const SAVED_KEY = 'credence_fingerprint';
export interface SavedFingerprint {
  id: number; // the server's row for this device
  name: string; // whose account, shown on the sign-in button
  workspace: string | null;
}

export function savedFingerprint(): SavedFingerprint | null {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_KEY) || 'null');
    return v && v.name ? v : null;
  } catch {
    return null;
  }
}
function setSaved(v: SavedFingerprint | null) {
  try {
    if (v) localStorage.setItem(SAVED_KEY, JSON.stringify(v));
    else localStorage.removeItem(SAVED_KEY);
  } catch {
    // storage unavailable — the button just won't be offered
  }
}

const isApp = () => Capacitor.isNativePlatform();
const plugin = async () => (await import('@capgo/capacitor-native-biometric')).NativeBiometric;

// Does this phone / browser have a fingerprint (or face, Windows Hello…) set up?
export async function fingerprintSupported(): Promise<boolean> {
  try {
    if (isApp()) return (await (await plugin()).isAvailable()).isAvailable;
    const pkc = (window as any).PublicKeyCredential;
    return !!pkc && (await pkc.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

async function call(path: string, token: string | null, body?: any, method = 'POST') {
  const res = await fetch(apiUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { code: data.code });
  return data;
}

// Plugin codes: 11 app cancel, 15 system cancel, 16 user cancel, 17 "Use password".
const cancelled = (e: any) => [11, 15, 16, 17].includes(Number(e?.code)) || /cancel|abort|NotAllowedError/i.test(`${e?.name || ''} ${e?.message || ''}`);

// Turn it on for this device (after signing in with the password).
export async function enableFingerprint(token: string, user: User, workspace: string | null): Promise<void> {
  if (isApp()) {
    const nb = await plugin();
    const device = await appDeviceInfo();
    const { secret } = await call('/api/auth/fingerprint/app', token, device || {});
    try {
      const { AccessControl } = await import('@capgo/capacitor-native-biometric');
      await nb.setCredentials({ username: String(user.id), password: secret, server: SERVER, accessControl: AccessControl.BIOMETRY_CURRENT_SET, title: 'Turn on fingerprint sign-in', negativeButtonText: 'Cancel' });
    } catch (e: any) {
      throw new Error(cancelled(e) ? 'Cancelled — fingerprint sign-in was not turned on.' : "Couldn't save the fingerprint on this phone.");
    }
  } else {
    const { startRegistration } = await import('@simplewebauthn/browser');
    const optionsJSON = await call('/api/auth/fingerprint/passkey/options', token, {});
    let response;
    try {
      response = await startRegistration({ optionsJSON });
    } catch (e: any) {
      throw new Error(cancelled(e) ? 'Cancelled — fingerprint sign-in was not turned on.' : e?.message || "This browser couldn't save a fingerprint.");
    }
    await call('/api/auth/fingerprint/passkey', token, { response, label: browserLabel() });
  }
  const list = await call('/api/auth/fingerprint', token, undefined, 'GET');
  setSaved({ id: Number(list.devices?.[0]?.id || 0), name: user.name || user.email || '', workspace });
}

// Remove one (this device's also forgets it locally).
export async function removeFingerprint(token: string, id: number): Promise<void> {
  await call(`/api/auth/fingerprint/${id}`, token, undefined, 'DELETE');
  if (savedFingerprint()?.id === id) await forgetHere();
}
export async function forgetHere() {
  setSaved(null);
  if (isApp()) await (await plugin()).deleteCredentials({ server: SERVER }).catch(() => {});
}

// Sign in. `extra` is what the password sign-in also sends (workspace, and on
// the app the location + device fields).
export async function fingerprintLogin(extra: Record<string, any>): Promise<{ token: string; user: any; active_company_id?: number }> {
  try {
    if (isApp()) {
      const nb = await plugin();
      let creds;
      try {
        creds = await nb.getSecureCredentials({ server: SERVER, title: 'Sign in to CredenceHR', reason: 'Sign in to CredenceHR', negativeButtonText: 'Use password' });
      } catch (e: any) {
        if (cancelled(e)) throw Object.assign(new Error(''), { code: 'CANCELLED' });
        const code = Number(e?.code);
        if (code === 10) throw new Error("The fingerprint didn't match. Try again or sign in with your password.");
        if (code === 2 || code === 4) throw new Error('Too many tries — the phone has locked fingerprint for now. Sign in with your password.');
        // Fingerprints on the phone changed, or the saved one is gone.
        await forgetHere();
        throw new Error('Fingerprint sign-in needs to be turned on again — sign in with your password, then Profile → Fingerprint login.');
      }
      return await call('/api/auth/fingerprint/app/login', null, { ...extra, secret: creds.password });
    }
    const { startAuthentication } = await import('@simplewebauthn/browser');
    const { key, ...optionsJSON } = await call('/api/auth/fingerprint/passkey/login-options', null, {});
    let response;
    try {
      response = await startAuthentication({ optionsJSON: optionsJSON as any });
    } catch (e: any) {
      if (cancelled(e)) throw Object.assign(new Error(''), { code: 'CANCELLED' });
      throw e;
    }
    return await call('/api/auth/fingerprint/passkey/login', null, { ...extra, key, response });
  } catch (e: any) {
    if (e?.code === 'FINGERPRINT_NOT_SET') await forgetHere();
    throw e;
  }
}

function browserLabel() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` · ${os}` : ''}`;
}
