/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

// The small Infinity loader used while the app reloads: a faint full Infinity
// with one bright stretch running round it, in the theme's own colour
// (--g-accent: Orange / Violet / Mono). It is plain SVG + CSS (index.css
// .chr-infinity), so it draws at once, and index.html draws the very same
// picture on the start screen — the loader never changes shape between the
// pull-down overlay, the start screen and the first app screen.
export const INFINITY_PATH = 'M50 30 C58 14 90 12 90 30 C90 48 58 46 50 30 C42 14 10 12 10 30 C10 48 42 46 50 30 Z';

export const InfinityLoader: React.FC<{ width?: number; className?: string }> = ({ width = 96, className }) => (
  <svg
    className={`chr-infinity ${className || ''}`}
    viewBox="0 0 100 60"
    width={width}
    height={(width * 60) / 100}
    aria-hidden="true"
  >
    <path className="chr-infinity-track" d={INFINITY_PATH} pathLength={100} />
    <path className="chr-infinity-run" d={INFINITY_PATH} pathLength={100} />
  </svg>
);

// The same pale page + loader the start screen shows (index.html), for the
// moments right after it while the app's code loads — only after a reload on
// the website or a pull-down reload in the app, never at the app's normal start.
export const BootVeil: React.FC = () => {
  if (typeof document === 'undefined' || !document.documentElement.hasAttribute('data-pull-reload')) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ background: 'var(--pr-bg, var(--g-bg, #fff8f3))', color: 'var(--pr-accent, var(--g-accent, #ff6700))' }}
      role="progressbar"
      aria-label="Loading CredenceHR"
    >
      <InfinityLoader />
    </div>
  );
};
