/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// "Calls on this phone" (Android app, accounts with Calls access only — it is
// mounted by CallLayer / the Chat Calls tab, which are themselves behind
// users.can_use_calls). What the phone must allow for a call to ring with the
// app closed: notifications, the full-screen call screen (Android 14+),
// "Display over other apps" (the call screen while the phone is in use) and
// no battery optimisation. Each row opens that page of the phone's Settings;
// the ticks refresh when the person comes back.

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, BatteryCharging, Check, Maximize2, PhoneCall, Smartphone, X } from 'lucide-react';
import { getCallSetup, openCallSetting, type CallSetup } from '../lib/callAudio';

const ROWS: { key: keyof CallSetup; title: string; desc: string; icon: React.ReactNode; optional?: boolean }[] = [
  { key: 'notifications', title: 'Notifications', desc: 'Calls and messages can show on this phone.', icon: <Bell className="w-5 h-5" /> },
  { key: 'fullScreen', title: 'Full-screen call screen', desc: 'A call opens over the lock screen, like a phone call.', icon: <Maximize2 className="w-5 h-5" /> },
  { key: 'battery', title: 'Battery: not restricted', desc: "So the phone doesn't stop calls reaching CredenceHR.", icon: <BatteryCharging className="w-5 h-5" /> },
  { key: 'overlay', title: 'Display over other apps', desc: 'The call screen also opens while you use another app.', icon: <Smartphone className="w-5 h-5" />, optional: true }
];

/** null on the website / an older APK; refreshes when the app comes back on screen. */
export function useCallSetup(): CallSetup | null {
  const [setup, setSetup] = useState<CallSetup | null>(null);
  const load = useCallback(() => void getCallSetup().then(setSetup), []);
  useEffect(() => {
    load();
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', load);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', load);
    };
  }, [load]);
  return setup;
}

/** Something a call needs (the optional overlay aside) is still off. */
export const callSetupMissing = (s: CallSetup | null) => !!s && (!s.notifications || !s.fullScreen || !s.battery);

export const CallSetupSheet: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const setup = useCallSetup();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[95] liquid-glass-backdrop flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Calls on this phone"
        onClick={(e) => e.stopPropagation()}
        className="liquid-glass liquid-glass-in w-full sm:max-w-md rounded-t-[32px] sm:rounded-[32px] max-h-[92vh] overflow-y-auto"
        style={{ paddingBottom: 'calc(var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 1.25rem)' }}
      >
        <button type="button" onClick={onClose} aria-label="Close" className="liquid-glass-chip absolute top-4 right-4 z-10 w-9 h-9 rounded-full flex items-center justify-center text-slate-600">
          <X className="w-4 h-4" />
        </button>
        <div className="px-5 pt-6 sm:px-6">
          <div className="liquid-glass-inset w-12 h-12 rounded-2xl flex items-center justify-center text-violet-600">
            <PhoneCall className="w-6 h-6" />
          </div>
          <h2 className="mt-3 text-lg font-bold text-slate-900">Calls on this phone</h2>
          <p className="text-sm text-slate-600 leading-snug">For a call to ring with your phone's ringtone when CredenceHR is closed, turn these on.</p>
          <div className="mt-4 liquid-glass-inset rounded-2xl divide-y divide-white/70">
            {ROWS.map((r) => {
              const on = setup ? setup[r.key] : false;
              return (
                <div key={r.key} className="flex items-center gap-3 px-3.5 py-3">
                  <span className={`shrink-0 ${on ? 'text-emerald-600' : 'text-slate-400'}`}>{r.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-800">
                      {r.title}
                      {r.optional && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">optional</span>}
                    </p>
                    <p className="text-xs text-slate-500 leading-snug">{r.desc}</p>
                  </div>
                  {on ? (
                    <span className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                      <Check className="w-4 h-4" /> On
                    </span>
                  ) : (
                    <button type="button" onClick={() => void openCallSetting(r.key)} className="liquid-glass-button rounded-full shrink-0 px-3 py-1.5 text-xs font-semibold">
                      Turn on
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-slate-500 leading-snug">
            Some phones (Xiaomi, Oppo, Vivo, Realme) also need <b>Autostart</b> on for CredenceHR, and <b>Show on lock screen</b> under its other permissions.
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
};

const PROMPT_KEY = 'credence_call_setup_prompt';
const PROMPT_EVERY_MS = 7 * 24 * 3600 * 1000;

/** Asks once a week, on the Android app, while something a call needs is off. */
export const CallSetupPrompt: React.FC = () => {
  const setup = useCallSetup();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!callSetupMissing(setup) || open) return;
    let last = 0;
    try {
      last = Number(localStorage.getItem(PROMPT_KEY) || 0);
    } catch {
      // storage unavailable: ask
    }
    if (Date.now() - last < PROMPT_EVERY_MS) return;
    const t = setTimeout(() => {
      setOpen(true);
      try {
        localStorage.setItem(PROMPT_KEY, String(Date.now()));
      } catch {
        // fine
      }
    }, 4000);
    return () => clearTimeout(t);
  }, [setup, open]);
  return open ? <CallSetupSheet onClose={() => setOpen(false)} /> : null;
};
