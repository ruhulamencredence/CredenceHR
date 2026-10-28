/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';

// Fixes a real bug, not just a "hard to see" one: on the Android Capacitor
// WebView, an element with `backdrop-filter` can render its blur correctly
// on the very first paint after a cold reload, then silently fall back to
// its flat background for the rest of that page's life — no further
// interaction needed to lose it, and no interaction brings it back. This is
// a known Chromium compositor issue: the GPU raster surface a
// `backdrop-filter` layer needs is sometimes not promoted in time for that
// first paint after a reload, and once the layer settles without it, the
// browser doesn't retry.
//
// `transform: translateZ(0)` (already applied inline via style on the
// elements that use this hook) is the usual hint to promote a layer, but on
// its own it isn't reliably enough on this WebView to force a *re-evaluation*
// after the fact. Nudging the transform value one frame after mount — off
// its resting value and immediately back — forces the compositor to redo
// layer promotion for this element, which reliably restores the blur. Two
// rAFs (rather than a timeout) keep the nudge tied to actual paint frames and
// keep the shift imperceptible: the user never sees the intermediate value.
export function useBackdropBlurRepaintFix<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const raf1 = requestAnimationFrame(() => {
      el.style.transform = 'translateZ(0.01px)';
      el.style.webkitTransform = 'translateZ(0.01px)';
      requestAnimationFrame(() => {
        el.style.transform = 'translateZ(0)';
        el.style.webkitTransform = 'translateZ(0)';
      });
    });

    return () => cancelAnimationFrame(raf1);
  }, []);

  return ref;
}
