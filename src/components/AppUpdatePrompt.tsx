// "Update available" — the Android app tells its user when the APK on the
// server (downloads/, GET /api/app/android-latest) is newer than the one on
// the phone (App.getInfo().build = the APK's versionCode).
//
// The screens come from the server, so even an app built before this popup
// existed shows it. Those older apps (versionCode 1) can't hand a download to
// the browser, so they get the link to copy or share instead; newer ones
// (MainActivity's DownloadListener) open it in the browser with one tap.
//
// "Later" hides it for a day, for that version only.

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Share } from '@capacitor/share';
import { X, Download, Copy, Share2, CheckCircle2 } from 'lucide-react';
import { apiUrl } from '../lib/api';

interface Latest {
  version_code: number;
  version_name: string | null;
  url: string;
}

const SNOOZE_KEY = (code: number) => `credence_app_update_later_${code}`;
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

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return;
    let cancelled = false;
    (async () => {
      try {
        const info = await App.getInfo();
        const build = Number(info.build) || 0;
        const res = await fetch(apiUrl('/api/app/android-latest'));
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data.available || !(Number(data.version_code) > build) || snoozed(Number(data.version_code))) return;
        setOneTap(build > 1);
        setLatest({ version_code: Number(data.version_code), version_name: data.version_name || null, url: String(data.url) });
      } catch {
        // offline, or no App plugin: no prompt
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!latest) return null;
  const link = new URL(latest.url, window.location.origin).href;

  const later = () => {
    try {
      localStorage.setItem(SNOOZE_KEY(latest.version_code), String(Date.now() + DAY_MS));
    } catch {
      // private storage off: it just asks again next time
    }
    setLatest(null);
  };
  const update = () => {
    setStarted(true);
    window.location.href = link;
  };
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
    <div className="fixed inset-0 z-[95] liquid-glass-backdrop flex items-end sm:items-center justify-center p-3 sm:p-4">
      <div role="dialog" aria-label="Update available" className="liquid-glass liquid-glass-in rounded-[32px] max-w-sm w-full max-h-[92vh] overflow-y-auto">
        <button
          type="button"
          onClick={later}
          className="liquid-glass-chip absolute top-3.5 right-3.5 z-10 p-1.5 text-slate-600 hover:text-slate-900 rounded-full"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="px-6 pt-6 pb-5">
          <div className="liquid-glass-inset w-14 h-14 rounded-[20px] flex items-center justify-center mb-3">
            <Download className="w-6 h-6" style={{ color: 'var(--g-accent)' }} />
          </div>
          <h2 className="text-lg font-bold text-slate-900">Update available</h2>
          <p className="mt-1 text-sm text-slate-600">
            A newer CredenceHR app{latest.version_name ? ` (${latest.version_name})` : ''} is ready. Update to get the latest fixes.
          </p>

          {oneTap ? (
            <>
              <button type="button" onClick={update} className="liquid-glass-button w-full mt-5 py-3 rounded-full font-semibold">
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
          <button type="button" onClick={later} className="w-full mt-1 py-1.5 text-xs font-semibold text-slate-500">
            Later
          </button>
        </div>
      </div>
    </div>
  );
};
