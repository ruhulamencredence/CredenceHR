/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The placeholder a page or a section shows while its data loads — a few
// skeleton rows (or cards) in place of the old lone spinner in an empty
// area, which read as a blank page. Shown at once; light enough to sit
// inside any card.

import React from 'react';

const Bar: React.FC<{ className: string }> = ({ className }) => <div className={`rounded bg-slate-200/80 ${className}`} />;

export const LoadingBlock: React.FC<{ variant?: 'list' | 'cards'; rows?: number; className?: string }> = ({ variant = 'list', rows = 5, className = '' }) =>
  variant === 'cards' ? (
    <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 py-2 animate-pulse ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="rounded-2xl border border-slate-200 bg-white/80 p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-slate-200/80 shrink-0" />
            <Bar className={`h-3 ${i % 2 ? 'w-1/2' : 'w-2/3'}`} />
          </div>
          <Bar className="h-2.5 w-full bg-slate-200/60" />
          <Bar className="h-2.5 w-4/5 bg-slate-200/60" />
        </div>
      ))}
    </div>
  ) : (
    <div className={`py-2 animate-pulse divide-y divide-slate-100 ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="px-4 py-3.5 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-slate-200/80 shrink-0" />
          <div className="flex-1 space-y-2 min-w-0">
            <Bar className={`h-3 ${i % 3 === 0 ? 'w-1/2' : i % 3 === 1 ? 'w-2/3' : 'w-2/5'}`} />
            <Bar className="h-2.5 w-1/3 bg-slate-200/60" />
          </div>
          <Bar className="h-5 w-14 rounded-full bg-slate-200/60 shrink-0" />
        </div>
      ))}
    </div>
  );
