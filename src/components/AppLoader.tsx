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

// Shared app-wide loading indicator — same component/bundle for both the
// web build and the Capacitor mobile app (APK), so it's "the app's loader"
// on both. Renders a pulsing skeleton-card layout (stat tiles + a couple of
// content blocks) in place of the old Infinity Lottie spinner — this way
// the loader itself already hints at "a dashboard is coming" instead of a
// generic spinner, and drops the lottie-react + infinity-loader.json
// dependency from this path entirely.
//
// NOTE: this only covers loading states that happen AFTER React has
// mounted (Suspense fallbacks, in-panel data fetches, etc.). The very
// first, JS-free boot spinner in index.html (shown the instant the HTML
// arrives, before any JS has run) has to stay a plain CSS ring for that
// reason — it can't render skeleton markup that hasn't downloaded yet.
export const AppLoader: React.FC<AppLoaderProps> = ({ label, minHeight = '60vh', size }) => (
  <div
    className="w-full px-4 py-6 sm:px-6"
    style={{ minHeight }}
    role="status"
    aria-label={label || 'Loading'}
  >
    <div className="max-w-6xl mx-auto space-y-4">
      {/* Stat tiles row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-2xl p-3.5 flex flex-col gap-2 border border-slate-200 animate-pulse">
            <div className="w-9 h-9 rounded-full bg-slate-200" />
            <div className="h-2.5 bg-slate-200 rounded w-3/4" />
            <div className="h-4 bg-slate-100 rounded w-1/2" />
          </div>
        ))}
      </div>

      {/* Content blocks */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 border border-slate-200 rounded-2xl p-5 animate-pulse">
          <div className="h-4 bg-slate-200 rounded w-32 mb-4" />
          <div className="space-y-2.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-8 bg-slate-100 rounded-lg w-full" />
            ))}
          </div>
        </div>
        <div className="border border-slate-200 rounded-2xl p-5 animate-pulse">
          <div className="h-4 bg-slate-200 rounded w-20 mb-4" />
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-1.5 pb-3 border-b border-slate-50 last:border-0">
                <div className="h-3 bg-slate-200 rounded w-3/4" />
                <div className="h-2.5 bg-slate-100 rounded w-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  </div>
);
