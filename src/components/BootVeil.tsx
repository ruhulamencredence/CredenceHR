/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ThemedInfinity } from './ThemedInfinity';

// The pale page the start screen (index.html) shows after a reload on the
// website or a pull-down reload in the app, kept going with the app's own
// Infinity loader (the Lottie animation, in the theme colour) while the app's
// code loads — so there is no blank moment before the first screen. At the
// app's normal start it renders nothing.
let warmed = false;
export const BootVeil: React.FC = () => {
  if (typeof document === 'undefined' || !document.documentElement.hasAttribute('data-pull-reload')) return null;
  if (!warmed) {
    warmed = true;
    // Fetch the animation player now so the loader appears with the page.
    import('lottie-react/full').catch(() => {});
  }
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ background: 'var(--pr-bg, var(--g-bg, #fff8f3))' }}
      role="progressbar"
      aria-label="Loading CredenceHR"
    >
      <ThemedInfinity size={115} />
    </div>
  );
};
