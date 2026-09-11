/**
 * Fullscreen open animation, shown ONCE right after the native cold-start
 * splash (drawable/splash.png) hands off to the WebView — i.e. the moment
 * the app "becomes fullscreen". Only runs on the native APK
 * (Capacitor.isNativePlatform()); the website build never shows it.
 *
 * Uses the static C-HR logo SVG + a plain CSS fade/scale — no lottie-react,
 * no JSON asset, no import to resolve at build time.
 */
import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import chrLogo from '../assets/chr-logo.svg';

const ANIMATION_MS = 1800; // must match the CSS animation-duration below

export function BootIntroAnimation({ onDone }: { onDone: () => void }) {
  const [fadingOut, setFadingOut] = useState(false);

  useEffect(() => {
    const fadeStart = setTimeout(() => setFadingOut(true), ANIMATION_MS - 300);
    const finish = setTimeout(onDone, ANIMATION_MS);
    return () => {
      clearTimeout(fadeStart);
      clearTimeout(finish);
    };
  }, [onDone]);

  return (
    <div
      onClick={onDone} // let an impatient user tap through
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Matches the logo's own gradient dark stop — no color flash
        // around the edges of the (rounded-square) logo tile.
        background: '#3C1494',
        opacity: fadingOut ? 0 : 1,
        transition: 'opacity 300ms ease-out',
      }}
    >
      <img
        src={chrLogo}
        alt="C-HR"
        style={{
          width: '38vw',
          maxWidth: 180,
          minWidth: 96,
          animation: 'chrBootIntro 1.8s cubic-bezier(0.22, 1, 0.36, 1) both',
        }}
      />
      <style>{`
        @keyframes chrBootIntro {
          0%   { opacity: 0; transform: scale(0.7); }
          55%  { opacity: 1; transform: scale(1.06); }
          100% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}

/** True only inside the built APK — false on the plain website build. */
export function shouldShowBootIntro() {
  return Capacitor.isNativePlatform();
}
