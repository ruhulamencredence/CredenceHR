/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The "turn on location tracking" notice (sent from Employee Tracking ->
// Currently Not Tracked), shown by NoticePopup in place of the plain notice:
// the journey animation on top, the message, step-by-step instructions for the
// phone, and "Set up Now" — which in the Android app opens CredenceHR's own
// page in the phone's Settings (Permissions -> Location). Same card on the
// web, where the steps tell them what to do on the phone.

import React, { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { BatteryCharging, ChevronDown, ChevronUp, LocateFixed, MapPin, Smartphone, X } from 'lucide-react';
import { Lottie } from 'lottie-react';
import { ActiveNotice } from '../types';
import journeyAnimation from '../assets/journey.json';
import { openAppLocationSettings } from '../lib/backgroundTracking';

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
            {/* Journey animation (src/assets/journey.json, 16:9). */}
            <div className="aspect-video rounded-[22px] overflow-hidden border border-violet-100 bg-violet-50/40 pointer-events-none">
              <Lottie src={journeyAnimation as any} autoplay loop className="w-full h-full" />
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
