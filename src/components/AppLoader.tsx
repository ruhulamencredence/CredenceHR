/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

interface AppLoaderProps {
  label?: string;
  minHeight?: string | number;
  size?: number;
}

// The app's plain "loading" mark for the few places with no page-shaped
// skeleton of their own: a small spinning ring in the theme colour. (It used
// to draw a made-up dashboard of grey cards, which looked like a broken
// page wherever it showed.)
export const AppLoader: React.FC<AppLoaderProps> = ({ label, minHeight = '60vh', size = 36 }) => (
  <div className="w-full flex flex-col items-center justify-center gap-3" style={{ minHeight }} role="status" aria-label={label || 'Loading'}>
    <span
      className="rounded-full animate-spin"
      style={{ width: size, height: size, border: '3px solid rgba(var(--g-accent-rgb, 244, 121, 32), 0.18)', borderTopColor: 'var(--g-accent, #f47920)' }}
    />
    {label && <span className="text-xs font-medium text-slate-500">{label}</span>}
  </div>
);
