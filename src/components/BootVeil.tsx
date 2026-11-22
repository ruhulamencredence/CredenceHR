/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { INFINITY_CYCLE, ThemedInfinity } from './ThemedInfinity';

// The pale page the start screen (index.html) shows after a reload on the
// website or a pull-down reload in the app, kept going with the app's own
// Infinity loader (the app's own loader as a self-animating SVG, in the theme colour) while the app's
// code loads — so there is no blank moment before the first screen. At the
// app's normal start it renders nothing.
export const BootVeil: React.FC = () => {
  if (typeof document === 'undefined' || !document.documentElement.hasAttribute('data-pull-reload')) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ background: 'var(--pr-bg, var(--g-bg, #fff8f3))' }}
      role="progressbar"
      aria-label="Loading CredenceHR"
    >
      <ThemedInfinity size={115} continueFromStart />
    </div>
  );
};

// After a reload the loader plays at least one whole round (about 1.7 s from
// the start of the page) before the app shows, even when the app was ready
// sooner — so it never flashes by half drawn. Only after a reload on the
// website or a pull-down reload in the app (index.html leaves data-pull-reload);
// a page that has already taken longer shows no extra wait.
const HOLD_MS = Math.ceil(INFINITY_CYCLE * 1000) + 60;
export const LoaderHold: React.FC = () => {
  const [phase, setPhase] = useState<'on' | 'fading' | 'off'>(() =>
    typeof document !== 'undefined' && document.documentElement.hasAttribute('data-pull-reload') && performance.now() < HOLD_MS ? 'on' : 'off'
  );
  useEffect(() => {
    if (phase === 'on') {
      const t = window.setTimeout(() => setPhase('fading'), Math.max(0, HOLD_MS - performance.now()));
      return () => window.clearTimeout(t);
    }
    if (phase === 'fading') {
      const t = window.setTimeout(() => setPhase('off'), 260);
      return () => window.clearTimeout(t);
    }
  }, [phase]);
  if (phase === 'off') return null;
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center"
      style={{ background: 'var(--pr-bg, var(--g-bg, #fff8f3))', opacity: phase === 'fading' ? 0 : 1, transition: 'opacity 240ms ease-out', pointerEvents: 'all' }}
      role="progressbar"
      aria-label="Loading CredenceHR"
    >
      <ThemedInfinity size={115} continueFromStart />
    </div>
  );
};
