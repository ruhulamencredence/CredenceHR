/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The background-location "prominent disclosure" Google Play requires: before
// the Android app asks for location permission for Employee Tracking, a
// screen of its own says plainly what is collected (location, even when the
// app is closed or not in use), why, and who sees it, and the person has to
// tap Agree. Only after that do Android's own permission prompts appear.
//
//   if (!(await ensureLocationConsent())) return;
//
// The answer is remembered on this phone. "Not now" is respected: tracking is
// not started and the screen isn't shown again on every launch — it comes
// back only when the person taps "Set up Now" on the tracking notice.
// Android app only; everywhere else it answers true without showing anything
// (there is no background tracking there).

import React, { useEffect, useRef, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { BellRing, Clock, LogOut, MapPin, ShieldCheck, Users } from 'lucide-react';
import { Lottie } from 'lottie-react';
import trackingAnimation from '../assets/gps-navigation.json';
import { PrivacyPolicy } from '../components/PrivacyPolicy';

const CONSENT_KEY = 'credence_bg_location_consent';
export type LocationConsent = 'accepted' | 'declined' | null;

const isAndroidApp = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

export function getLocationConsent(): LocationConsent {
  if (!isAndroidApp()) return 'accepted';
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === 'accepted' || v === 'declined' ? v : null;
  } catch {
    return null;
  }
}

function saveConsent(v: 'accepted' | 'declined') {
  try {
    localStorage.setItem(CONSENT_KEY, v);
  } catch {
    // Storage blocked — the screen just shows again next time.
  }
}

const POINTS: { icon: React.ComponentType<{ className?: string }>; text: string }[] = [
  {
    icon: MapPin,
    text: 'Sends your location, its accuracy and the battery level every few minutes — every few seconds while you are on a ride or an authorised admin opens Live Follow.'
  },
  { icon: Users, text: 'Seen only by your supervisor, HR and admins your company allows. Never sold or used for ads.' },
  { icon: Clock, text: 'Used to check attendance, field visits and travel claims, and to show a ride’s progress.' },
  { icon: BellRing, text: 'Android shows a notification while tracking is on.' },
  { icon: LogOut, text: 'Stops when you sign out. You can turn it off any time in Settings → Apps → CredenceHR → Location.' }
];

function DisclosureCard({ onDone }: { onDone: (ok: boolean) => void }) {
  const [showPolicy, setShowPolicy] = useState(false);
  const agreeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => agreeRef.current?.focus(), []);
  if (showPolicy) return <PrivacyPolicy onClose={() => setShowPolicy(false)} />;
  return (
    // No tap-outside-to-close: leaving the screen is not an answer (Google
    // wants an explicit choice), so only the two buttons close it.
    <div className="liquid-glass-backdrop fixed inset-0 z-[1000] flex items-end sm:items-center justify-center p-3 sm:p-4" role="presentation">
      <div
        className="w-full max-w-sm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="loc-disclosure-title"
        aria-describedby="loc-disclosure-text"
      >
        <div className="liquid-glass liquid-glass-in rounded-[32px] max-h-[92vh] flex flex-col overflow-hidden">
          <div className="overflow-y-auto">
            <div className="p-3 pb-0">
              <div className="liquid-glass-inset h-28 rounded-[24px] overflow-hidden pointer-events-none flex items-center justify-center px-4">
                <Lottie src={trackingAnimation as any} autoplay loop className="h-full aspect-[351/174] max-w-full" />
              </div>
            </div>
            <div className="px-6 pt-5">
              <h3 id="loc-disclosure-title" className="text-lg font-bold text-slate-900 leading-snug">
                Use your location in the background
              </h3>
              <p id="loc-disclosure-text" className="mt-2 text-sm text-slate-700 leading-relaxed">
                CredenceHR collects location data to enable <span className="font-semibold">Employee Tracking</span> for your company, including{' '}
                <span className="font-semibold">when the app is closed or not in use</span>, while you are signed in.
              </p>
              <ul className="mt-4 space-y-2.5">
                {POINTS.map((p) => (
                  <li key={p.text} className="flex gap-3">
                    <span className="liquid-glass-inset shrink-0 w-8 h-8 rounded-xl text-violet-700 flex items-center justify-center">
                      <p.icon className="w-4 h-4" />
                    </span>
                    <span className="text-xs text-slate-600 leading-relaxed pt-0.5">{p.text}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-slate-500 leading-relaxed">
                If you agree, Android will ask for location permission next — choose “Allow all the time”. Read the{' '}
                <button type="button" onClick={() => setShowPolicy(true)} className="font-semibold text-violet-700 underline">
                  Privacy Policy
                </button>
                .
              </p>
            </div>
          </div>
          <div className="px-6 pt-4 pb-5 shrink-0 flex gap-2.5">
            <button
              type="button"
              onClick={() => onDone(false)}
              className="liquid-glass-chip flex-1 rounded-full py-2.5 text-sm font-semibold text-slate-700"
            >
              Not now
            </button>
            <button
              ref={agreeRef}
              type="button"
              onClick={() => onDone(true)}
              className="liquid-glass-button flex-[1.4] rounded-full py-2.5 text-sm font-semibold inline-flex items-center justify-center gap-1.5"
            >
              <ShieldCheck className="w-4 h-4" />
              Agree
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let open: Promise<boolean> | null = null;

// Shows the screen and saves the answer. A second call while it is open gets
// the same answer instead of a second screen.
export function askLocationDisclosure(): Promise<boolean> {
  if (!isAndroidApp()) return Promise.resolve(true);
  if (open) return open;
  open = new Promise<boolean>((resolve) => {
    if (!host) {
      host = document.createElement('div');
      host.setAttribute('data-location-disclosure', '');
      document.body.appendChild(host);
      root = createRoot(host);
    }
    const done = (ok: boolean) => {
      saveConsent(ok ? 'accepted' : 'declined');
      root!.render(<></>);
      open = null;
      resolve(ok);
    };
    root!.render(<DisclosureCard key={Date.now()} onDone={done} />);
  });
  return open;
}

// On sign-in: true if tracking may start. Asks only when this phone has never
// answered; an earlier "Not now" stays a no until the person asks to set up.
export async function ensureLocationConsent(): Promise<boolean> {
  const c = getLocationConsent();
  if (c === 'accepted') return true;
  if (c === 'declined') return false;
  return askLocationDisclosure();
}
