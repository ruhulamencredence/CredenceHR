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
// NEVER return the plugin itself from an async function or put it in a promise:
// a Capacitor plugin is a proxy that answers EVERY property, "then" included, so
// the promise machinery would "call" a native method named then and wait for ever
// (the dialog's check never finished and the button stayed off). It is wrapped
// in a plain object, and used as `.api`.
const plugin = async () => ({ api: (await import('@capgo/capacitor-native-biometric')).NativeBiometric });
type Bio = Awaited<ReturnType<typeof plugin>>;

// The app's pages come from the server, so they can be newer than the
// installed APK. An APK built before the fingerprint plugin was added has no
// native NativeBiometric; Capacitor then quietly falls back to the plugin's
// web mock, which says "available" and "saves" without ever asking for a
// fingerprint. So on the app the native plugin must really be there.
export const APP_TOO_OLD =
  "This version of the CredenceHR app doesn't have fingerprint support yet. Install the latest app (ask IT for the new APK), then try again.";
const nativePluginMissing = () => isApp() && !Capacitor.isPluginAvailable('NativeBiometric');

// 'ok'; 'app_old' (the installed app lacks the plugin); 'no_sensor' (no fingerprint /
// face / Windows Hello set up here).
export async function fingerprintStatus(): Promise<'ok' | 'app_old' | 'no_sensor'> {
  try {
    if (nativePluginMissing()) return 'app_old';
    if (isApp()) return (await within((await plugin()).api.isAvailable(), 10000, 'The phone\'s fingerprint check')).isAvailable ? 'ok' : 'no_sensor';
    const pkc = (window as any).PublicKeyCredential;
    return !!pkc && (await pkc.isUserVerifyingPlatformAuthenticatorAvailable()) ? 'ok' : 'no_sensor';
  } catch {
    return 'no_sensor';
  }
}
// One line for the dialog's footer: which web build this is, where it runs, whether the
// native plugin is there and what the sensor reports — enough to tell what's wrong
// without a debugger.
export async function fingerprintDetails(): Promise<string> {
  const parts = [`web build ${typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : '?'}`, isApp() ? `app (${Capacitor.getPlatform()})` : 'browser'];
  try {
    if (isApp()) {
      parts.push(`plugin ${Capacitor.isPluginAvailable('NativeBiometric') ? 'native' : 'MISSING'}`);
      if (!nativePluginMissing()) {
        const r: any = await within((await plugin()).api.isAvailable(), 8000, 'isAvailable');
        parts.push(`sensor ${r.isAvailable ? 'ok' : 'not ready'}`, `type ${r.biometryType}`, `strong ${r.strongBiometryIsAvailable ? 'yes' : 'no'}`);
        if (r.errorCode !== undefined) parts.push(`error ${r.errorCode}`);
      }
    }
  } catch (e: any) {
    parts.push(`check failed: ${why(e)}`);
  }
  return parts.join(' · ');
}
export async function fingerprintSupported(): Promise<boolean> {
  return (await fingerprintStatus()) === 'ok';
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

// A step that never answers becomes an error that names the step, so the
// dialog never just sits there.
const within = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} didn't answer in ${Math.round(ms / 1000)} seconds.`)), ms);
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
const why = (e: any) => [e?.code !== undefined ? `code ${e.code}` : '', e?.message || String(e || '')].filter(Boolean).join(': ');

// Turn it on for this device (after signing in with the password). `step`
// tells the screen which step is running.
export async function enableFingerprint(token: string, user: User, workspace: string | null, step: (text: string) => void = () => {}): Promise<void> {
  if (nativePluginMissing()) throw new Error(APP_TOO_OLD);
  if (isApp()) {
    step('1/3 Checking this phone…');
    let nb: Bio;
    let device: Awaited<ReturnType<typeof appDeviceInfo>>;
    try {
      nb = await within(plugin(), 10000, 'The fingerprint part of the app');
      device = await within(appDeviceInfo(), 10000, 'Reading this phone');
    } catch (e: any) {
      throw new Error(`Couldn't start (${why(e)}).`);
    }
    step('2/3 Registering this phone with the server…');
    const { secret } = await within(call('/api/auth/fingerprint/app', token, device || {}), 20000, 'The server');
    step('3/3 Waiting for your fingerprint — touch the sensor when the phone asks…');
    try {
      const { AccessControl } = await import('@capgo/capacitor-native-biometric');
      await within(
        nb.api.setCredentials({ username: String(user.id), password: secret, server: SERVER, accessControl: AccessControl.BIOMETRY_CURRENT_SET, title: 'Turn on fingerprint sign-in', negativeButtonText: 'Cancel' }),
        90000,
        'The phone\'s fingerprint window'
      );
    } catch (e: any) {
      throw new Error(cancelled(e) ? 'Cancelled — fingerprint sign-in was not turned on.' : `Couldn't save the fingerprint on this phone (${why(e)}).`);
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
  if (isApp()) await (await plugin()).api.deleteCredentials({ server: SERVER }).catch(() => {});
}

// The saved secret is really gone (removed, or the phone's fingerprints
// changed so the key was wiped): only then is "turn it on again" right. Any
// other failure — the sensor busy as the app opens, the window closed by the
// system — keeps the setup, so the next try can just work.
const credentialsGone = (e: any) =>
  Number(e?.code) === 21 || /no (protected )?credentials found|enrollment changed|key permanently invalidated/i.test(String(e?.message || ''));

// What a failed fingerprint window means for the sign-in screen: a cancel
// (say nothing), the message to show, and whether the saved setup is gone.
export function fingerprintFailure(e: any): { cancelled: boolean; forget: boolean; message: string } {
  const r = (message: string, forget = false) => ({ cancelled: false, forget, message });
  if (cancelled(e)) return { cancelled: true, forget: false, message: '' };
  const code = Number(e?.code);
  if (code === 10) return r("The fingerprint didn't match. Try again or sign in with your password.");
  if (code === 2 || code === 4) return r('Too many tries — the phone has locked fingerprint for now. Sign in with your password.');
  if (credentialsGone(e)) return r('Fingerprint sign-in needs to be turned on again — sign in with your password, then Profile → Fingerprint login.', true);
  if (code === 3) return r("No fingerprint is set up on this phone right now — add one in the phone's settings, or sign in with your password.");
  if (code === 1) return r('The fingerprint sensor is busy or not ready — wait a moment and tap “Sign in with fingerprint” again.');
  return r(`The fingerprint window didn't open (${why(e) || 'no reason given'}). Tap “Sign in with fingerprint” to try again, or sign in with your password.`);
}

// Sign in. `extra` gives what the password sign-in also sends (workspace, and
// on the app the location + device fields); it is asked for only after the
// fingerprint matched, so the phone's fingerprint window opens straight away
// instead of after a GPS fix.
export async function fingerprintLogin(extra: () => Promise<Record<string, any>>): Promise<{ token: string; user: any; active_company_id?: number }> {
  try {
    if (nativePluginMissing()) throw new Error(APP_TOO_OLD);
    if (isApp()) {
      const nb = await plugin();
      let creds;
      try {
        creds = await within(
          nb.api.getSecureCredentials({ server: SERVER, title: 'Sign in to CredenceHR', reason: 'Sign in to CredenceHR', negativeButtonText: 'Use password' }),
          120000,
          "The phone's fingerprint window"
        );
      } catch (e: any) {
        const r = fingerprintFailure(e);
        if (r.forget) await forgetHere();
        throw r.cancelled ? Object.assign(new Error(''), { code: 'CANCELLED' }) : new Error(r.message);
      }
      return await call('/api/auth/fingerprint/app/login', null, { ...(await extra()), secret: creds.password });
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
    return await call('/api/auth/fingerprint/passkey/login', null, { ...(await extra()), key, response });
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
