/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// "Tutorials" (mobile More popup, the menu's Self Service list): the guided
// tours this account can use (src/lib/tutorials.ts — no tour of a page the
// account can't open), a ✓ on the ones finished and how many are done.
// Picking one closes this and starts it (GuidedTour.tsx).

import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { User } from '../types';
import { startTour, toursFor, useTutorialsState } from '../lib/tutorials';
import { useBackButtonClose } from '../lib/useBackButtonClose';

export const TutorialsSheet: React.FC<{ user: User; onClose: () => void }> = ({ user, onClose }) => {
  const { done } = useTutorialsState();
  useBackButtonClose(true, onClose);
  const tours = toursFor(user);
  const n = tours.filter((t) => done.includes(t.id)).length;

  return createPortal(
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label="Tutorials">
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={onClose} />
      {/* Positioned by this wrapper — .liquid-glass sets position: relative. */}
      <div
        className="absolute inset-x-0 bottom-0 md:inset-auto md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-[420px] px-2 md:px-0"
        style={{ paddingBottom: 'max(0.5rem, var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))' }}
      >
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-4">
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <h2 className="text-[17px] font-extrabold text-slate-900">Tutorials</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Short guided tours on the real screens · {n} of {tours.length} done
              </p>
            </div>
            <button type="button" onClick={onClose} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="liquid-glass-inset h-1.5 rounded-full mt-3 overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: `${tours.length ? (n / tours.length) * 100 : 0}%`, background: 'linear-gradient(90deg, var(--g-cta-1, #6d28d9), var(--g-cta-2, #c084fc))' }} />
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {tours.map((t) => {
              const isDone = done.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    onClose();
                    startTour(t.id);
                  }}
                  className="liquid-glass-inset w-full flex items-center gap-3 rounded-[20px] px-3 py-2.5 text-left active:scale-[0.99] transition-transform"
                >
                  <span className="w-10 h-10 rounded-[14px] grid place-items-center text-lg shrink-0" style={{ background: t.tint }} aria-hidden="true">
                    {t.icon}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13.5px] font-bold text-slate-900">{t.title}</span>
                    <span className="block text-[11.5px] text-slate-500">About 1 minute</span>
                  </span>
                  {isDone ? (
                    <span className="text-[11px] font-extrabold text-emerald-700 bg-emerald-50 rounded-full px-2.5 py-1">✓ Done</span>
                  ) : (
                    <span className="text-[11.5px] font-extrabold text-violet-700 bg-violet-50 rounded-full px-2.5 py-1">▶ Start</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default TutorialsSheet;
