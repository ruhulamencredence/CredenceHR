/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Placeholders shown the instant a page is opened while its code downloads
// (App.tsx's Suspense fallbacks), so a page is never blank first:
//   AdminPageSkeleton — any Admin Panel tab: breadcrumb, title, toolbar and
//     a table card.
//   ListPageSkeleton  — Chat, Alerts and other list pages.
// Shown at once (no delay): a blank page reads as "broken", a skeleton
// that is gone in 100 ms does not. Kept free of heavy imports — App.tsx
// loads it with the app shell.

import React from 'react';

const Bar: React.FC<{ className: string }> = ({ className }) => <div className={`rounded bg-slate-200/80 ${className}`} />;

export const AdminPageSkeleton: React.FC = () => (
  <div className="w-full px-3 sm:px-6 lg:px-8 pt-4 pb-10 animate-pulse" role="status" aria-label="Loading">
    <Bar className="h-3 w-48 bg-slate-200/60" />
    <div className="flex items-center justify-between gap-3 mt-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-slate-200/80" />
        <div className="space-y-2">
          <Bar className="h-5 w-44" />
          <Bar className="h-3 w-64 bg-slate-200/60" />
        </div>
      </div>
      <div className="hidden sm:block h-9 w-32 rounded-xl bg-slate-200/80" />
    </div>
    <div className="flex items-center gap-2 mt-5">
      <div className="h-9 flex-1 max-w-md rounded-xl bg-white border border-slate-200" />
      <div className="h-9 w-28 rounded-xl bg-white border border-slate-200" />
    </div>
    <div className="mt-4 rounded-2xl bg-white border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex gap-6">
        {['w-24', 'w-20', 'w-28', 'w-16', 'w-20'].map((w, i) => (
          <Bar key={i} className={`h-3 ${w}`} />
        ))}
      </div>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="px-4 py-3.5 border-b border-slate-100 last:border-0 flex items-center gap-6">
          <div className="w-7 h-7 rounded-full bg-slate-200/80 shrink-0" />
          <Bar className={`h-3 ${i % 2 ? 'w-40' : 'w-52'}`} />
          <Bar className="h-3 w-28 bg-slate-200/60 hidden sm:block" />
          <Bar className="h-3 w-24 bg-slate-200/60 hidden md:block" />
          <Bar className="h-5 w-16 rounded-full bg-slate-200/60 ml-auto" />
        </div>
      ))}
    </div>
  </div>
);

export const ListPageSkeleton: React.FC = () => (
  <div className="w-full px-3 sm:px-6 lg:px-8 pt-4 pb-10 animate-pulse max-w-4xl" role="status" aria-label="Loading">
    <div className="flex items-center gap-3 mt-1">
      <div className="w-9 h-9 rounded-full bg-slate-200/80" />
      <Bar className="h-5 w-40" />
    </div>
    <div className="mt-5 rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="px-4 py-3.5 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-slate-200/80 shrink-0" />
          <div className="flex-1 space-y-2">
            <Bar className={`h-3 ${i % 2 ? 'w-1/2' : 'w-2/3'}`} />
            <Bar className="h-2.5 w-1/3 bg-slate-200/60" />
          </div>
          <Bar className="h-2.5 w-12 bg-slate-200/60" />
        </div>
      ))}
    </div>
  </div>
);
