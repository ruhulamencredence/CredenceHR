/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// <site>/sso/consume/<token> — where 360 ERP sends someone to open
// CredenceHR already signed in (Erp360InboundSsoRoutes.ts). The token is
// taken out of the address bar at once, spent on POST /api/auth/sso/consume
// (one use, ~2 minutes), and the person lands on the Dashboard — the same
// sign-in, with the same checks, as typing the password. Anything wrong
// shows why and offers the normal sign-in.
//
// - Website / iPhone / desktop: signs in straight away.
// - Android phone browser: asks whether to open the CredenceHR app
//   (credencehr://sso/consume/<token>, falls back to this page when the app
//   isn't installed) or carry on in the browser.
// - Inside the Android app: sends the location and device details a
//   password sign-in on the app sends (phone limit, App access).

import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { apiUrl } from '../lib/api';
import { appDeviceInfo } from '../lib/device';
import { clearScreenCache } from '../lib/screenCache';
import { setActiveCompanyId } from '../lib/company';

const TOKEN_RE = /^\/sso\/consume\/([0-9a-fA-F]{64})\/?$/;
export const ssoTokenFromPath = (pathname: string): string | null => TOKEN_RE.exec(pathname)?.[1]?.toLowerCase() || null;

async function appLocation(): Promise<{ latitude: number; longitude: number }> {
  const { Geolocation } = await import('@capacitor/geolocation');
  let status: string;
  try {
    status = (await Geolocation.checkPermissions()).location;
  } catch {
    status = 'prompt';
  }
  if (status !== 'granted') {
    try {
      status = (await Geolocation.requestPermissions()).location;
    } catch {
      status = 'denied';
    }
  }
  if (status !== 'granted') throw new Error('Location permission is required to sign in. Please allow location access and try again.');
  try {
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
    return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
  } catch {
    throw new Error("Couldn't get your location. Please check that GPS/Location is turned on and try again.");
  }
}

const SsoConsume: React.FC<{ token: string }> = ({ token }) => {
  const isApp = Capacitor.isNativePlatform();
  const onAndroidBrowser = !isApp && /Android/i.test(navigator.userAgent) && !new URLSearchParams(window.location.search).has('web');
  const [phase, setPhase] = useState<'choose' | 'working' | 'error'>(onAndroidBrowser ? 'choose' : 'working');
  const [error, setError] = useState('');
  const started = useRef(false);

  // The token never stays in the address bar or the browser history.
  useEffect(() => {
    try {
      window.history.replaceState(null, '', '/sso/consume');
    } catch {
      // ignore
    }
  }, []);

  const signIn = async () => {
    if (started.current) return;
    started.current = true;
    setPhase('working');
    try {
      let body: Record<string, any> = { token };
      if (isApp) {
        const device = await appDeviceInfo();
        const coords = await appLocation();
        body = { ...body, platform: 'app', latitude: coords.latitude, longitude: coords.longitude, ...(device || {}) };
      }
      const res = await fetch(apiUrl('/api/auth/sso/consume'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token || !data.user) throw new Error(data.error || 'Could not sign you in.');

      // Someone else signed in on this device before: end that sign-in.
      const old = localStorage.getItem('mpr_token');
      if (old && old !== data.token) {
        void fetch(apiUrl('/api/auth/logout'), { method: 'POST', headers: { Authorization: `Bearer ${old}` }, keepalive: true }).catch(() => {});
      }
      // Same as a password sign-in (App.tsx handleLoginSuccess): nothing
      // saved from an earlier sign-in is shown, and it opens on the Dashboard.
      clearScreenCache();
      localStorage.setItem('mpr_token', data.token);
      localStorage.setItem('mpr_user', JSON.stringify(data.user));
      setActiveCompanyId(data.active_company_id || null);
      const id = data.user.id;
      try {
        localStorage.removeItem(`mpr_self_service_view_${id}`);
        localStorage.removeItem(`mpr_show_profile_page_${id}`);
        localStorage.setItem(`mpr_view_mode_${id}`, 'user');
      } catch {
        // storage unavailable
      }
      window.location.replace('/');
    } catch (e: any) {
      setError(e instanceof TypeError ? "Couldn't reach the server. Check your connection and try again." : e.message || 'Could not sign you in.');
      setPhase('error');
    }
  };

  useEffect(() => {
    if (phase === 'working') void signIn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openInApp = () => {
    const fallback = `${window.location.origin}/sso/consume/${token}?web=1`;
    window.location.href = `intent://sso/consume/${token}#Intent;scheme=credencehr;package=com.mprtracker.app;S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center px-4" style={{ background: 'linear-gradient(160deg, #eaf6ff 0%, #dbeeff 30%, #e7dcff 65%, #ede0ff 100%)' }}>
      <div className="liquid-glass liquid-glass-in rounded-[32px] max-w-sm w-full p-6 text-center">
        <div className="text-lg font-bold text-slate-900">CredenceHR</div>
        {phase === 'working' && (
          <>
            <div className="mt-4 mx-auto w-8 h-8 rounded-full border-[3px] border-violet-200 border-t-violet-600 animate-spin" aria-hidden="true" />
            <p className="text-sm text-slate-600 mt-3" role="status">
              Signing you in from 360 ERP…
            </p>
          </>
        )}
        {phase === 'choose' && (
          <>
            <p className="text-sm text-slate-600 mt-2">Open CredenceHR from 360 ERP</p>
            <div className="mt-5 flex flex-col gap-2.5">
              <button type="button" onClick={openInApp} className="liquid-glass-button rounded-full px-5 py-2.5 text-sm font-semibold text-white bg-violet-600">
                Open in the CredenceHR app
              </button>
              <button type="button" onClick={() => void signIn()} className="rounded-full px-5 py-2.5 text-sm font-semibold text-violet-700 hover:bg-violet-50">
                Continue in the browser
              </button>
            </div>
          </>
        )}
        {phase === 'error' && (
          <>
            <p className="text-sm text-rose-700 mt-3">{error}</p>
            <button type="button" onClick={() => window.location.replace('/')} className="liquid-glass-button rounded-full px-5 py-2.5 text-sm font-semibold text-white bg-violet-600 mt-5">
              Sign in with password
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default SsoConsume;
