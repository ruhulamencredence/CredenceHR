// iPhone / iPad: CredenceHR as an app without the App Store — Safari's
// "Add to Home Screen" (manifest.webmanifest + the apple-* tags in
// index.html). The login page shows this button there instead of the
// Android APK one; once opened from the Home Screen it shows neither.

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Share, SquarePlus } from 'lucide-react';
import appStoreIcon from '../assets/app-store-ios.svg';

export const isIOSDevice = () =>
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

// Opened from the Home Screen (not a Safari tab).
export const isStandalone = () =>
  typeof window !== 'undefined' &&
  (((navigator as any).standalone as boolean | undefined) === true || !!window.matchMedia?.('(display-mode: standalone)').matches);

const inSafari = () => typeof navigator !== 'undefined' && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//i.test(navigator.userAgent);

export const AddToHomeScreenButton: React.FC = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-5 w-full flex items-center justify-center gap-2.5 py-3 px-5 rounded-2xl text-white transition-opacity hover:opacity-90"
        style={{ background: '#111318' }}
      >
        <img src={appStoreIcon} alt="" className="w-8 h-8 shrink-0" />
        <span className="flex flex-col items-start leading-tight">
          <span className="text-[10px] tracking-wide" style={{ color: 'rgba(255,255,255,0.65)' }}>
            GET THE APP ON
          </span>
          <span className="text-[15px] font-medium">iPhone Home Screen</span>
        </span>
      </button>
      {open && createPortal(<AddToHomeScreenSheet onClose={() => setOpen(false)} />, document.body)}
    </>
  );
};

const AddToHomeScreenSheet: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const safari = inSafari();
  return (
    <div className="fixed inset-0 z-[95] liquid-glass-backdrop flex items-end sm:items-center justify-center p-3 sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Add CredenceHR to your Home Screen"
        onClick={(e) => e.stopPropagation()}
        className="liquid-glass liquid-glass-in rounded-[32px] max-w-sm w-full max-h-[92vh] overflow-y-auto"
      >
        <button
          type="button"
          onClick={onClose}
          className="liquid-glass-chip absolute top-3.5 right-3.5 z-10 p-1.5 text-slate-600 hover:text-slate-900 rounded-full"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
        <div className="px-6 pt-6 pb-5">
          <div className="liquid-glass-inset w-16 h-16 rounded-[20px] flex items-center justify-center mb-3 overflow-hidden">
            <img src="/icons/app-180.png" alt="" className="w-12 h-12 rounded-[12px]" />
          </div>
          <h2 className="text-lg font-bold text-slate-900">Add CredenceHR to your iPhone</h2>
          <p className="mt-1 text-sm text-slate-600">It opens full screen from its own icon, like an app — no App Store needed.</p>

          {!safari && (
            <p className="mt-3 text-xs font-semibold text-amber-700">Open this page in Safari first — the steps below are in Safari.</p>
          )}
          <ol className="liquid-glass-inset mt-4 rounded-[20px] px-4 py-3.5 text-sm text-slate-700 space-y-3">
            <li className="flex items-center gap-3">
              <span className="w-6 h-6 shrink-0 rounded-full bg-white/80 text-xs font-bold flex items-center justify-center">1</span>
              <span>
                Tap <b>Share</b> <Share className="inline w-4 h-4 -mt-1 text-blue-600" aria-hidden="true" /> in Safari's toolbar.
              </span>
            </li>
            <li className="flex items-center gap-3">
              <span className="w-6 h-6 shrink-0 rounded-full bg-white/80 text-xs font-bold flex items-center justify-center">2</span>
              <span>
                Scroll down and tap <b>Add to Home Screen</b> <SquarePlus className="inline w-4 h-4 -mt-1" aria-hidden="true" />.
              </span>
            </li>
            <li className="flex items-center gap-3">
              <span className="w-6 h-6 shrink-0 rounded-full bg-white/80 text-xs font-bold flex items-center justify-center">3</span>
              <span>
                Tap <b>Add</b>, then open <b>CredenceHR</b> from your Home Screen and sign in.
              </span>
            </li>
          </ol>
          <p className="mt-3 text-[11px] text-slate-500">
            Notifications work from the Home Screen app (iOS 16.4 or later). Location tracking in the background needs the Android app.
          </p>
          <button type="button" onClick={onClose} className="liquid-glass-button w-full mt-5 py-3 rounded-full font-semibold">
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
