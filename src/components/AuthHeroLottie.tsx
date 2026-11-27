import React, { useEffect, useRef } from 'react';
import { Lottie, useLottieJson } from './LazyLottie';
// Fetched by itself when the login screen shows (not with the app's code),
// and kept on the device after the first time (lib/authHeroAsset.ts).
import { loadAuthHero } from '../lib/authHeroAsset';

// Split out from AuthScreen.tsx and loaded via React.lazy() there so the
// (fairly heavy) lottie-react library + this JSON animation are their own
// chunk, fetched/parsed AFTER the login form itself has already painted —
// instead of blocking the very first paint the boot spinner is covering for.
// Purely decorative, so a brief blank box while this chunk loads (see the
// Suspense fallback in AuthScreen.tsx) is not a problem.
// onReady: the animation is drawn — AuthScreen then hides its still picture.
// The outer span keeps the className (absolute inset-0 …) from AuthScreen.
const AuthHeroLottie: React.FC<{ className?: string; onReady?: () => void }> = ({ className, onReady }) => {
  const authHeroAnimation = useLottieJson(loadAuthHero);
  const box = useRef<HTMLSpanElement>(null);
  // Ready once the player has put its picture in the page (the player itself
  // loads lazily, after the data), then two frames to draw it. Not sooner:
  // AuthScreen hides its still on this, and there must be no blank moment.
  useEffect(() => {
    const el = box.current;
    if (!authHeroAnimation || !onReady || !el) return;
    let id = 0;
    const done = () => (id = requestAnimationFrame(() => (id = requestAnimationFrame(() => onReady()))));
    const drawn = () => !!el.querySelector('svg g');
    if (drawn()) {
      done();
      return () => cancelAnimationFrame(id);
    }
    const watch = new MutationObserver(() => {
      if (!drawn()) return;
      watch.disconnect();
      done();
    });
    watch.observe(el, { childList: true, subtree: true });
    return () => {
      watch.disconnect();
      cancelAnimationFrame(id);
    };
  }, [authHeroAnimation, onReady]);
  return (
    <span ref={box} className={className}>
      {authHeroAnimation && <Lottie src={authHeroAnimation} autoplay loop className="block w-full h-full" />}
    </span>
  );
};

export default AuthHeroLottie;
