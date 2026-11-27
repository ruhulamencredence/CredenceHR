// "Update available" — the Android app tells its user when the APK on the
// server (downloads/, GET /api/app/android-latest) is newer than the one on
// the phone (App.getInfo().build = the APK's versionCode).
//
// The screens come from the server, so even an app built before this popup
// existed shows it. Those older apps (versionCode 1) can't hand a download to
// the browser, so they get the link to copy or share instead; newer ones
// (MainActivity's DownloadListener) open it in the browser with one tap.
// An APK built with AppUpdaterPlugin (src/lib/appUpdater.ts) does it all
// itself: "Update now" downloads inside the app with a progress bar, asks
// once for Android's "Install unknown apps" switch, then opens Android's own
// install screen — one tap on Update. If that fails, "Download in browser"
// is the old way.
//
// "Later" hides it for a day, for that version only. An app older than the
// server's min_version_code (built before 14 Nov 2026 by default; the "Old
// app — update needed" in Employee Tracking) gets "Update required" instead:
// no Later and no close, the app can't be used until it's updated.

import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Share } from '@capacitor/share';
import { X, Download, Copy, Share2, CheckCircle2, ShieldCheck, RotateCw } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { AppUpdater, hasInAppUpdate, type UpdateProgress } from '../lib/appUpdater';

interface Latest {
  version_code: number;
  version_name: string | null;
  url: string;
  required: boolean;
}

const SNOOZE_KEY = (code: number) => `credence_app_update_later_${code}`;
// Set when Android's install screen is opened, so the app can say
// "Updated to …" once it starts again on the new version.
const PENDING_KEY = 'credence_app_update_pending';

type Step = 'idle' | 'downloading' | 'permission' | 'install' | 'failed';

const mb = (n: number) => (n / 1048576).toFixed(1);
const DAY_MS = 24 * 60 * 60 * 1000;

const snoozed = (code: number) => {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY(code)) || 0) > Date.now();
  } catch {
    return false;
  }
};

export const AppUpdatePrompt: React.FC = () => {
  const [latest, setLatest] = useState<Latest | null>(null);
  // This app can pass a download to the browser (built with the
  // DownloadListener, i.e. any versionCode above 1).
  const [oneTap, setOneTap] = useState(false);
  const [copied, setCopied] = useState(false);
  const [started, setStarted] = useState(false);
  // The in-app way (AppUpdaterPlugin), when this APK has it.
  const inApp = hasInAppUpdate();
  const [step, setStep] = useState<Step>('idle');
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState('');
  const [updatedTo, setUpdatedTo] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return;
    let cancelled = false;
    (async () => {
      try {
        const info = await App.getInfo();
        const build = Number(info.build) || 0;
        try {
          const pending = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
          if (pending && build >= Number(pending.code) && !cancelled) {
            localStorage.removeItem(PENDING_KEY);
            setUpdatedTo(pending.name || info.version || '');
            window.setTimeout(() => alive.current && setUpdatedTo(null), 5000);
          }
        } catch {
          // storage off: no "Updated" note
        }
        const res = await fetch(apiUrl('/api/app/android-latest'));
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data.available || !(Number(data.version_code) > build)) return;
        const required = build < (Number(data.min_version_code) || 0);
        if (!required && snoozed(Number(data.version_code))) return;
        setOneTap(build > 1);
        setLatest({ version_code: Number(data.version_code), version_name: data.version_name || null, url: String(data.url), required });
      } catch {
        // offline, or no App plugin: no prompt
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!latest) {
    return updatedTo !== null ? (
      <div className="fixed left-0 right-0 z-[96] flex justify-center px-4 pointer-events-none" style={{ top: 'calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 0.75rem)' }}>
        <div role="status" className="liquid-glass rounded-full px-4 py-2 text-sm font-semibold text-slate-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" /> CredenceHR updated{updatedTo ? ` to ${updatedTo}` : ''}
        </div>
      </div>
    ) : null;
  }
  const link = new URL(latest.url, window.location.origin).href;

  const later = () => {
    try {
      localStorage.setItem(SNOOZE_KEY(latest.version_code), String(Date.now() + DAY_MS));
    } catch {
      // private storage off: it just asks again next time
    }
    setLatest(null);
  };
  const inBrowser = () => {
    setStarted(true);
    window.location.href = link;
  };
  const openInstaller = async () => {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({ code: latest.version_code, name: latest.version_name }));
    } catch {
      // no "Updated" note then
    }
    try {
      await AppUpdater.install();
      if (alive.current) setStep('install');
    } catch (e: any) {
      if (!alive.current) return;
      setError(e?.message || 'Could not open the installer.');
      setStep('failed');
    }
  };
  const askPermission = async () => {
    try {
      const { allowed } = await AppUpdater.openInstallSettings();
      if (!alive.current) return;
      if (allowed) await openInstaller();
      else setStep('permission');
    } catch {
      if (alive.current) setStep('permission');
    }
  };
  const update = async () => {
    if (!inApp) return inBrowser();
    setError('');
    setProgress(null);
    setStep('downloading');
    const sub = await AppUpdater.addListener('progress', (p) => alive.current && setProgress(p));
    try {
      await AppUpdater.download({ url: link });
      if (!alive.current) return;
      const { allowed } = await AppUpdater.canInstall();
      if (allowed) await openInstaller();
      else setStep('permission');
    } catch (e: any) {
      if (!alive.current) return;
      if (e?.code === 'CANCELLED') {
        setStep('idle');
      } else {
        setError(e?.message || 'The download stopped.');
        setStep('failed');
      }
    } finally {
      sub.remove();
    }
  };
  const cancelDownload = () => {
    AppUpdater.cancel().catch(() => {});
  };
  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      return;
    } catch {
      // Some Android WebViews refuse the Clipboard API: the old way below.
    }
    const ta = document.createElement('textarea');
    ta.value = link;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      setCopied(document.execCommand('copy'));
    } catch {
      setCopied(false);
    }
    ta.remove();
  };
  const share = async () => {
    try {
      await Share.share({ title: 'CredenceHR app', text: 'Download the new CredenceHR app', url: link, dialogTitle: 'Open the link in a browser' });
    } catch {
      // closed, or sharing not available
    }
  };

  return (
    <div className={`fixed inset-0 ${latest.required ? 'z-[300]' : 'z-[95]'} liquid-glass-backdrop flex items-end sm:items-center justify-center p-3 sm:p-4`}>
      <div role="dialog" aria-modal="true" aria-label={latest.required ? 'Update required' : 'Update available'} className="liquid-glass liquid-glass-in rounded-[32px] max-w-sm w-full max-h-[92vh] overflow-y-auto">
        {!latest.required && step !== 'downloading' && (
        <button
          type="button"
          onClick={later}
          className="liquid-glass-chip absolute top-3.5 right-3.5 z-10 p-1.5 text-slate-600 hover:text-slate-900 rounded-full"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
        )}

        <div className="px-6 pt-6 pb-5">
          <div className="liquid-glass-inset w-14 h-14 rounded-[20px] flex items-center justify-center mb-3">
            <Download className="w-6 h-6" style={{ color: 'var(--g-accent)' }} />
          </div>
          <h2 className="text-lg font-bold text-slate-900">{latest.required ? 'Update required' : 'Update available'}</h2>
          <p className="mt-1 text-sm text-slate-600">
            {latest.required
              ? `This CredenceHR app is too old to keep using. Install the new app${latest.version_name ? ` (${latest.version_name})` : ''} to continue — your account and data stay as they are.`
              : `A newer CredenceHR app${latest.version_name ? ` (${latest.version_name})` : ''} is ready. Update to get the latest fixes.`}
          </p>

          {inApp ? (
            <>
              {step === 'idle' && (
                <button type="button" onClick={update} className="liquid-glass-button w-full mt-5 py-3 rounded-full font-semibold">
                  Update now
                </button>
              )}
              {step === 'downloading' && (
                <div className="mt-4" aria-live="polite">
                  <p className="text-sm font-semibold text-slate-800">Downloading the update…</p>
                  <div className="mt-2 h-2 rounded-full bg-slate-900/10 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
                    <div
                      className={`h-full rounded-full transition-[width] duration-200 ${pct === null ? 'w-1/3 animate-pulse' : ''}`}
                      style={{ background: 'var(--g-accent)', ...(pct !== null ? { width: `${pct}%` } : {}) }}
                    />
                  </div>
                  <div className="mt-1 flex justify-between text-[11px] text-slate-500 tabular-nums">
                    <span>{pct !== null ? `${pct}%` : 'Starting…'}</span>
                    {progress && <span>{progress.total > 0 ? `${mb(progress.loaded)} / ${mb(progress.total)} MB` : `${mb(progress.loaded)} MB`}</span>}
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500">Keep the app open until it finishes.</p>
                  <button type="button" onClick={cancelDownload} className="w-full mt-2 py-1.5 text-xs font-semibold text-slate-500">
                    Cancel
                  </button>
                </div>
              )}
              {step === 'permission' && (
                <div className="mt-4">
                  <div className="liquid-glass-inset rounded-[20px] px-4 py-3 text-xs text-slate-700 flex gap-2.5">
                    <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--g-accent)' }} />
                    <span>
                      Downloaded. Android needs your OK once: on the next screen turn on <b>Allow from this source</b>, then come back.
                      It won't ask again for later updates.
                    </span>
                  </div>
                  <button type="button" onClick={askPermission} className="liquid-glass-button w-full mt-4 py-3 rounded-full font-semibold">
                    Allow and install
                  </button>
                </div>
              )}
              {step === 'install' && (
                <div className="mt-4">
                  <p className="text-xs text-slate-600">
                    Tap <b>Update</b> on Android's screen. The app restarts on the new version — your login and data stay as they are.
                  </p>
                  <button type="button" onClick={openInstaller} className="liquid-glass-button w-full mt-4 py-3 rounded-full font-semibold">
                    Install
                  </button>
                </div>
              )}
              {step === 'failed' && (
                <div className="mt-4">
                  <p className="text-xs text-rose-600">The update didn't finish{error ? `: ${error}` : '.'} Check your connection and try again.</p>
                  <button type="button" onClick={update} className="liquid-glass-button w-full mt-4 py-3 rounded-full font-semibold flex items-center justify-center gap-2">
                    <RotateCw className="w-4 h-4" /> Try again
                  </button>
                  <button type="button" onClick={inBrowser} className="w-full mt-2 py-2 text-xs font-semibold text-slate-600 flex items-center justify-center gap-1.5">
                    <Download className="w-3.5 h-3.5" /> Download in browser
                  </button>
                  {started && (
                    <p className="mt-1 text-center text-[11px] text-slate-500">
                      Your browser is downloading it — open the download and tap Install.
                    </p>
                  )}
                </div>
              )}
            </>
          ) : oneTap ? (
            <>
              <button type="button" onClick={inBrowser} className="liquid-glass-button w-full mt-5 py-3 rounded-full font-semibold">
                Update now
              </button>
              {started && (
                <p className="mt-2 text-center text-[11px] text-slate-500">
                  Your browser is downloading it — open the download and tap Install.
                </p>
              )}
            </>
          ) : (
            <>
              <ol className="liquid-glass-inset mt-4 rounded-[20px] px-4 py-3 text-xs text-slate-700 space-y-1.5 list-decimal list-inside">
                <li>Copy the link below.</li>
                <li>Open Chrome (or any browser) and paste it.</li>
                <li>Open the downloaded file and tap Install.</li>
              </ol>
              <p className="mt-3 text-[11px] text-slate-500 break-all select-all" aria-label="Download link">
                {link}
              </p>
              <button type="button" onClick={copy} className="liquid-glass-button w-full mt-4 py-3 rounded-full font-semibold flex items-center justify-center gap-2">
                {copied ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Link copied — paste it in Chrome' : 'Copy link'}
              </button>
              <button type="button" onClick={share} className="w-full mt-2 py-2 text-xs font-semibold text-slate-600 flex items-center justify-center gap-1.5">
                <Share2 className="w-3.5 h-3.5" /> Share link
              </button>
            </>
          )}
          {!latest.required && step !== 'downloading' && (
            <button type="button" onClick={later} className="w-full mt-1 py-1.5 text-xs font-semibold text-slate-500">
              Later
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
