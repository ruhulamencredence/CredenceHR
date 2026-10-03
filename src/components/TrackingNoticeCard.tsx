/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The "turn on location tracking" notice (sent from Employee Tracking ->
// Currently Not Tracked), shown by NoticePopup in place of the plain notice:
// a map with a route on top, the message, step-by-step instructions for the
// phone, and "Set up Now" — which in the Android app opens CredenceHR's own
// page in the phone's Settings (Permissions -> Location). Same card on the
// web, where the steps tell them what to do on the phone.

import React, { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { BatteryCharging, ChevronDown, ChevronUp, LocateFixed, MapPin, Smartphone, X } from 'lucide-react';
import { ActiveNotice } from '../types';
import { openAppLocationSettings } from '../lib/backgroundTracking';

// Map with a winding route from a start point to a location pin (the sketch).
const RouteMap: React.FC = () => (
  <svg viewBox="0 0 320 170" preserveAspectRatio="xMidYMid slice" className="w-full h-full" role="img" aria-label="Map with a route">
    <defs>
      <linearGradient id="tn-land" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#ecfdf5" />
        <stop offset="1" stopColor="#e0f2fe" />
      </linearGradient>
      <filter id="tn-shadow" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#7F00FF" floodOpacity="0.35" />
      </filter>
    </defs>
    <rect width="320" height="170" fill="url(#tn-land)" />
    {/* blocks and streets */}
    <g fill="#ffffff" opacity="0.9">
      <rect x="14" y="14" width="64" height="40" rx="6" />
      <rect x="92" y="14" width="88" height="40" rx="6" />
      <rect x="194" y="14" width="44" height="40" rx="6" />
      <rect x="14" y="68" width="40" height="48" rx="6" />
      <rect x="150" y="68" width="60" height="44" rx="6" />
      <rect x="252" y="96" width="54" height="60" rx="6" />
      <rect x="70" y="128" width="96" height="30" rx="6" />
    </g>
    <path d="M0 62 H320 M0 122 H320 M86 0 V170 M244 0 V170" stroke="#dbeafe" strokeWidth="6" />
    <circle cx="214" cy="140" r="14" fill="#bbf7d0" opacity="0.8" />
    <circle cx="40" cy="146" r="10" fill="#bbf7d0" opacity="0.8" />
    {/* route */}
    <path
      d="M38 132 C 60 132, 62 92, 92 92 S 126 132, 150 128 S 176 74, 206 82 S 236 120, 262 74"
      fill="none"
      stroke="#7F00FF"
      strokeOpacity="0.18"
      strokeWidth="12"
      strokeLinecap="round"
    />
    <path
      d="M38 132 C 60 132, 62 92, 92 92 S 126 132, 150 128 S 176 74, 206 82 S 236 120, 262 74"
      fill="none"
      stroke="#7F00FF"
      strokeWidth="4"
      strokeLinecap="round"
      strokeDasharray="2 9"
    >
      <animate attributeName="stroke-dashoffset" from="22" to="0" dur="1.2s" repeatCount="indefinite" />
    </path>
    {/* start */}
    <circle cx="38" cy="132" r="9" fill="#ffffff" stroke="#7F00FF" strokeWidth="4" />
    {/* pin */}
    <g filter="url(#tn-shadow)" transform="translate(262 74)">
      <path d="M0 0 C -14 -16, -16 -24, -16 -32 A16 16 0 1 1 16 -32 C 16 -24, 14 -16, 0 0 Z" fill="#7F00FF" />
      <circle cx="0" cy="-32" r="6.5" fill="#ffffff" />
    </g>
    <ellipse cx="262" cy="76" rx="9" ry="3" fill="#7F00FF" opacity="0.25" />
  </svg>
);

const STEPS: { icon: React.ComponentType<{ className?: string }>; title: string; text: string }[] = [
  { icon: LocateFixed, title: 'Turn on Location', text: "Swipe down from the top of the phone and tap Location (GPS) so it's on." },
  {
    icon: MapPin,
    title: 'Allow location "All the time"',
    text: 'Settings → Apps → CredenceHR → Permissions → Location → choose "Allow all the time", and turn on "Use precise location".'
  },
  { icon: BatteryCharging, title: 'Let it run in the background', text: 'In the same app page: Battery → "Unrestricted" (or "Don\'t optimise"), so the phone doesn\'t stop tracking.' },
  { icon: Smartphone, title: 'Open CredenceHR', text: 'Come back to the CredenceHR app and stay signed in during working hours.' }
];

interface Props {
  notice: ActiveNotice;
  remaining: number;
  busy: boolean;
  onDone: () => void;
}

export const TrackingNoticeCard: React.FC<Props> = ({ notice, remaining, busy, onDone }) => {
  const isAndroidApp = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  const [showSteps, setShowSteps] = useState(true);
  const [settingsFailed, setSettingsFailed] = useState(false);

  const setUpNow = async () => {
    if (isAndroidApp) {
      const opened = await openAppLocationSettings();
      if (!opened) {
        setSettingsFailed(true);
        setShowSteps(true);
        return;
      }
    }
    onDone();
  };

  return (
    <div className="fixed inset-0 z-[90] bg-slate-950/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-3 sm:p-4">
      <div
        role="dialog"
        aria-label={notice.title}
        className="bg-white rounded-[28px] max-w-sm w-full max-h-[92vh] flex flex-col overflow-hidden shadow-2xl relative"
      >
        <button
          type="button"
          onClick={onDone}
          className="absolute top-3 right-3 z-10 p-1.5 text-slate-500 bg-white/80 hover:bg-white rounded-full shadow-sm"
          aria-label="Close notice"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="overflow-y-auto">
          {/* Map */}
          <div className="p-3 pb-0">
            <div className="h-40 rounded-[22px] overflow-hidden border border-violet-100">
              <RouteMap />
            </div>
          </div>

          {/* Message */}
          <div className="px-6 pt-5">
            <h3 className="text-lg font-bold text-slate-900 leading-snug">{notice.title}</h3>
            <div
              className="mt-2 text-sm text-slate-600 leading-relaxed [&_p+p]:mt-2"
              dangerouslySetInnerHTML={{ __html: notice.content_html }}
            />
          </div>

          {/* Tutorial */}
          <div className="px-6 pt-4">
            <button
              type="button"
              onClick={() => setShowSteps((v) => !v)}
              className="w-full flex items-center justify-between text-xs font-bold uppercase tracking-wide text-violet-700"
            >
              How to turn it on
              {showSteps ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            {showSteps && (
              <ol className="mt-3 space-y-3">
                {STEPS.map((s, i) => (
                  <li key={s.title} className="flex gap-3">
                    <span className="relative shrink-0 w-9 h-9 rounded-xl bg-violet-50 text-violet-700 flex items-center justify-center">
                      <s.icon className="w-4 h-4" />
                      <span className="absolute -top-1.5 -left-1.5 w-4 h-4 rounded-full bg-violet-600 text-white text-[9px] font-bold flex items-center justify-center">
                        {i + 1}
                      </span>
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-slate-800">{s.title}</span>
                      <span className="block text-xs text-slate-500 leading-relaxed">{s.text}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {settingsFailed && (
              <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Couldn't open Settings automatically — please follow the steps above.
              </p>
            )}
            {!isAndroidApp && (
              <p className="mt-3 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                Tracking runs from the CredenceHR app on your phone. Open the app there and tap “Set up Now” to go straight to its location settings.
              </p>
            )}
          </div>
        </div>

        {/* Action */}
        <div className="px-6 pt-4 pb-5 shrink-0">
          <button
            type="button"
            onClick={setUpNow}
            disabled={busy}
            className="w-full py-3 rounded-2xl text-white font-semibold shadow-[0_8px_20px_-6px_rgba(127,0,255,0.55)] disabled:opacity-50"
            style={{ background: 'var(--g-accent, #7F00FF)' }}
          >
            {isAndroidApp ? 'Set up Now' : 'OK, I’ll set it up on my phone'}
          </button>
          {isAndroidApp && (
            <button type="button" onClick={onDone} className="w-full mt-2 py-1.5 text-xs font-semibold text-slate-500">
              Later
            </button>
          )}
          {remaining > 0 && (
            <p className="mt-1.5 text-center text-[11px] text-slate-400">
              {remaining} more notice{remaining === 1 ? '' : 's'} waiting
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
