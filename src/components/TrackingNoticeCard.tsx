/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The "turn on location tracking" notice (sent from Employee Tracking ->
// Currently Not Tracked), shown by NoticePopup in place of the plain notice:
// the journey animation on top, the message, step-by-step instructions for the
// phone, and "Set up Now". In the Android app that button walks through the
// permission itself: the in-app dialog ("While using the app"), then
// CredenceHR's Location permission page ("Allow all the time"), and checks
// again when the person comes back, starting tracking once it's all there.
// Same card on the web, where the steps tell them what to do on the phone.

import React, { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { BatteryCharging, Check, CheckCircle2, ChevronDown, ChevronUp, Circle, LocateFixed, MapPin, Smartphone, X } from 'lucide-react';
import { Lottie } from 'lottie-react';
import { ActiveNotice } from '../types';
import journeyAnimation from '../assets/journey.json';
import {
  getLocationAccess,
  LocationAccessStatus,
  openAppLocationSettings,
  openPhoneLocationSwitch,
  requestAllTheTimeLocation,
  requestForegroundLocation,
  restartBackgroundTracking
} from '../lib/backgroundTracking';

// In the Android app "Set up Now" does steps 1–2 itself.
const APP_STEPS: { icon: React.ComponentType<{ className?: string }>; title: string; text: string }[] = [
  { icon: MapPin, title: 'Tap Set up Now', text: 'Choose "While using the app" in the box that appears.' },
  { icon: MapPin, title: 'Choose "Allow all the time"', text: 'The Location page for CredenceHR opens — tap "Allow all the time", turn on "Use precise location", then go back.' },
  { icon: LocateFixed, title: 'Turn on Location', text: "If the phone's Location (GPS) is off, turn it on." },
  { icon: BatteryCharging, title: 'Let it run in the background', text: 'Settings → Apps → CredenceHR → Battery → "Unrestricted", so the phone doesn\'t stop tracking.' }
];

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

// Shown once location is allowed all the time and tracking is running.
const ThankYou: React.FC = () => (
  <div className="overflow-y-auto px-6 pt-10 pb-2 flex flex-col items-center text-center">
    <div className="liquid-glass-pop relative w-24 h-24 rounded-full flex items-center justify-center bg-gradient-to-b from-emerald-300 to-emerald-500 text-white shadow-[0_14px_30px_-10px_rgba(16,185,129,0.7),inset_0_2px_0_rgba(255,255,255,0.6)] ring-8 ring-white/50">
      <Check className="w-12 h-12" strokeWidth={3} />
    </div>
    <h3 className="mt-6 text-2xl font-bold text-slate-900">Thank you!</h3>
    <p className="mt-2 text-sm text-slate-700 leading-relaxed">
      Location is now allowed <span className="font-semibold">all the time</span> and Employee Tracking is on. Thanks for setting it up so quickly.
    </p>
    <p className="mt-3 text-xs text-slate-500">Keep Location (GPS) on and stay signed in to CredenceHR during working hours.</p>
  </div>
);

interface Props {
  notice: ActiveNotice;
  remaining: number;
  busy: boolean;
  onDone: () => void;
}

export const TrackingNoticeCard: React.FC<Props> = ({ notice, remaining, busy, onDone }) => {
  const isAndroidApp = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  const [showSteps, setShowSteps] = useState(!isAndroidApp);
  const [settingsFailed, setSettingsFailed] = useState(false);
  // Android app: what the phone has now. undefined = not read yet; null = an
  // APK without the LocationAccess plugin (falls back to opening Settings).
  const [access, setAccess] = useState<LocationAccessStatus | null | undefined>(isAndroidApp ? undefined : null);
  const [working, setWorking] = useState(false);
  // Set after an attempt that came back without "Allow all the time".
  const [stillMissing, setStillMissing] = useState(false);
  const allSet = !!access && access.foreground && access.background && access.locationOn;
  // "Allow all the time" (and the rest) is on: the card turns into a thank-you.
  const thanked = allSet;

  const refresh = useCallback(async () => {
    const s = await getLocationAccess();
    setAccess(s);
    return s;
  }, []);

  useEffect(() => {
    if (!isAndroidApp) return;
    void refresh();
    // Back from Settings (App info page or the Location switch): read again.
    const sub = App.addListener('resume', () => void refresh());
    return () => {
      void sub.then((h) => h.remove());
    };
  }, [isAndroidApp, refresh]);

  // Once "All the time" is there, (re)start tracking with it.
  const [restarted, setRestarted] = useState(false);
  useEffect(() => {
    if (!allSet || restarted) return;
    setRestarted(true);
    setStillMissing(false);
    void restartBackgroundTracking();
  }, [allSet, restarted]);

  const oldApkSetUp = async () => {
    const opened = await openAppLocationSettings();
    if (!opened) {
      setSettingsFailed(true);
      setShowSteps(true);
      return;
    }
    onDone();
  };

  const setUpNow = async () => {
    if (!isAndroidApp) return onDone();
    if (access === null) return oldApkSetUp();
    if (!access || allSet) return onDone();
    setWorking(true);
    try {
      let s: LocationAccessStatus = access;
      // 1. The in-app dialog: "While using the app".
      if (!s.foreground) {
        const r = await requestForegroundLocation();
        if (r.openedSettings) return; // read again on 'resume'
        s = r.status;
        if (!s.foreground) {
          setAccess(s);
          setStillMissing(true);
          return;
        }
      }
      // 2. CredenceHR's Location permission page: "Allow all the time".
      if (!s.background) {
        const r = await requestAllTheTimeLocation();
        if (r.openedSettings) return;
        s = r.status;
        if (!s.background) setStillMissing(true);
      }
      // 3. The phone's Location switch.
      if (s.background && !s.locationOn) await openPhoneLocationSwitch();
      setAccess(s);
    } catch {
      setSettingsFailed(true);
      setShowSteps(true);
    } finally {
      setWorking(false);
    }
  };

  const buttonLabel = !isAndroidApp
    ? 'OK, I’ll set it up on my phone'
    : allSet
      ? 'Done'
      : access && access.foreground && access.background && !access.locationOn
        ? 'Turn on Location'
        : 'Set up Now';

  return (
    <div className="fixed inset-0 z-[90] liquid-glass-backdrop flex items-end sm:items-center justify-center p-3 sm:p-4">
      <div
        role="dialog"
        aria-label={notice.title}
        className="liquid-glass liquid-glass-in rounded-[32px] max-w-sm w-full max-h-[92vh] flex flex-col overflow-hidden"
      >
        <button
          type="button"
          onClick={onDone}
          className="liquid-glass-chip absolute top-3.5 right-3.5 z-10 p-1.5 text-slate-600 hover:text-slate-900 rounded-full"
          aria-label="Close notice"
        >
          <X className="w-4 h-4" />
        </button>

        {thanked ? (
          <ThankYou />
        ) : (
        <div className="overflow-y-auto">
          {/* Map */}
          <div className="p-3 pb-0">
            {/* Journey animation (src/assets/journey.json, 16:9). */}
            <div className="liquid-glass-inset aspect-video rounded-[24px] overflow-hidden pointer-events-none">
              <Lottie src={journeyAnimation as any} autoplay loop className="w-full h-full" />
            </div>
          </div>

          {/* Message */}
          <div className="px-6 pt-5">
            <h3 className="text-lg font-bold text-slate-900 leading-snug">{notice.title}</h3>
            <div
              className="mt-2 text-sm text-slate-700 leading-relaxed [&_p+p]:mt-2"
              dangerouslySetInnerHTML={{ __html: notice.content_html }}
            />
          </div>

          {/* Android app: what's done so far */}
          {access && (
            <div className="px-6 pt-4">
              <ul className="liquid-glass-inset rounded-2xl divide-y divide-white/70">
                {[
                  { ok: access.foreground, label: 'Location permission' },
                  { ok: access.background, label: 'Allow all the time' },
                  { ok: access.locationOn, label: 'Location (GPS) on' }
                ].map((r) => (
                  <li key={r.label} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                    {r.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <Circle className="w-4 h-4 text-slate-300" />}
                    <span className={r.ok ? 'text-slate-800 font-medium' : 'text-slate-500'}>{r.label}</span>
                  </li>
                ))}
              </ul>
              {!allSet && stillMissing && (
                <p className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  {access.foreground
                    ? 'Location is still not set to "Allow all the time". Tap Set up Now again and choose "Allow all the time" on the page that opens.'
                    : 'Location permission was not given. Tap Set up Now again and choose "While using the app".'}
                </p>
              )}
            </div>
          )}

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
                {(access ? APP_STEPS : STEPS).map((s, i) => (
                  <li key={s.title} className="flex gap-3">
                    <span className="liquid-glass-inset relative shrink-0 w-9 h-9 rounded-xl text-violet-700 flex items-center justify-center">
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
              <p className="liquid-glass-inset mt-3 text-xs text-slate-600 rounded-lg px-3 py-2">
                Tracking runs from the CredenceHR app on your phone. Open the app there and tap “Set up Now” to go straight to its location settings.
              </p>
            )}
          </div>
        </div>
        )}

        {/* Action */}
        <div className="px-6 pt-4 pb-5 shrink-0">
          <button
            type="button"
            onClick={setUpNow}
            disabled={busy || working}
            className="liquid-glass-button w-full py-3 rounded-full font-semibold disabled:opacity-50"
          >
            {buttonLabel}
          </button>
          {isAndroidApp && !allSet && (
            <button type="button" onClick={onDone} className="w-full mt-2 py-1.5 text-xs font-semibold text-slate-500">
              Later
            </button>
          )}
          {remaining > 0 && (
            <p className="mt-1.5 text-center text-[11px] text-slate-500">
              {remaining} more notice{remaining === 1 ? '' : 's'} waiting
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
