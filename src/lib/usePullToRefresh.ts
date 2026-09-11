/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';

// Manual "pull down from the top to reload" gesture for the mobile APK.
//
// Sometimes the app genuinely needs a manual reload (a stuck request, a stale
// list, etc.) — previously the only way to do that was to force-close the app
// from Android's recent-apps screen, which loses whatever screen/section you
// were on (see the "sitting idle reloads the app" note in UserPanel.tsx: a
// forced reload used to always dump you back at the Dashboard). Now that the
// current page/section (Admin tab, User Panel section, in-progress MPR
// Entry draft — see App.tsx / AdminPanel.tsx / UserPanel.tsx) is mirrored to
// localStorage, a reload can safely land back on the exact same screen — so
// this exposes a simple swipe-down-from-the-top gesture that reloads on
// purpose, instead of needing to force-close the app.
//
// Only triggers when the page is already scrolled to the very top (pulling
// down from mid-scroll just scrolls normally, as expected) and the pull
// passes a distance threshold before being released.
export function usePullToRefresh(threshold = 80) {
  const [pullDistance, setPullDistance] = useState(0);
  const [ready, setReady] = useState(false);
  // True for the brief window between "finger lifted, reload committed" and
  // the actual window.location.reload() — lets the UI swap the small pull
  // pill for a fullscreen app-loader and fade it in instead of the page just
  // freezing/flashing white the instant the reload fires.
  const [triggering, setTriggering] = useState(false);
  // False the instant the finger lifts (touchend) without reaching the
  // threshold — App.tsx uses this to turn on a short CSS transition only
  // for that "snap back to 0" moment, so an abandoned pull eases back up
  // instead of the pill jumping away instantly. Stays true while the
  // finger is actually down, since transitioning during a live drag would
  // make the pill visibly lag behind the touch.
  const [dragging, setDragging] = useState(false);
  const startYRef = useRef<number | null>(null);

  useEffect(() => {
    const atTop = () => (document.scrollingElement?.scrollTop ?? window.scrollY) <= 0;

    const onTouchStart = (e: TouchEvent) => {
      if (!atTop()) {
        startYRef.current = null;
        return;
      }
      startYRef.current = e.touches[0].clientY;
      setDragging(true);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (startYRef.current === null) return;
      if (!atTop()) {
        // Scrolled away from the top mid-gesture (e.g. content grew) —
        // abandon the pull instead of reloading unexpectedly.
        startYRef.current = null;
        setPullDistance(0);
        setReady(false);
        return;
      }
      const delta = e.touches[0].clientY - startYRef.current;
      if (delta <= 0) {
        setPullDistance(0);
        setReady(false);
        return;
      }
      // Resistance curve so it doesn't feel like a 1:1 drag — pulling
      // further gives diminishing visual movement, same feel as native
      // pull-to-refresh.
      const eased = Math.min(threshold * 1.6, delta * 0.5);
      setPullDistance(eased);
      setReady(eased >= threshold);
    };

    const onTouchEnd = () => {
      if (ready) {
        // Hold the pill at full extension and switch to the fullscreen
        // loader for a beat before actually reloading, so the transition
        // reads as an intentional "loading now" hand-off rather than an
        // abrupt cut. 380ms matches the fade timing below.
        setTriggering(true);
        window.setTimeout(() => window.location.reload(), 380);
        return;
      }
      startYRef.current = null;
      setDragging(false);
      setPullDistance(0);
      setReady(false);
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, threshold]);

  return { pullDistance, ready, threshold, triggering, dragging };
}
