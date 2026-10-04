/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Loading placeholder for the User Dashboard (UserPanel.tsx) — same layout,
// card shapes and colours as the real Dashboard, so the page doesn't jump
// when it arrives:
//   web (md+): gradient welcome banner, then a 2/3-column grid of white
//     cards (My Attendance, Leave Summary with its violet header, Today,
//     Book a Ride, My Asset) and full-width My Requests / Notice Board.
//   mobile: gradient banner with the attendance card overlapping it, the
//     Leave Summary card, then the 3-column glass tile menu.

import React from 'react';

const Bar: React.FC<{ className: string }> = ({ className }) => <div className={`rounded bg-slate-200/80 ${className}`} />;

const WhiteCard: React.FC<{ className?: string; children: React.ReactNode }> = ({ className = '', children }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden ${className}`}>{children}</div>
);

// Header row every white Dashboard card has: icon + title, subtitle, divider.
const CardHeader: React.FC<{ link?: boolean }> = ({ link }) => (
  <div className="px-5 pt-5 pb-4 sm:px-6 border-b border-slate-200 flex items-start justify-between gap-3">
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="w-4 h-4 rounded bg-slate-200" />
        <Bar className="h-4 w-28" />
      </div>
      <Bar className="h-3 w-40 bg-slate-100" />
    </div>
    {link && <Bar className="h-3 w-16 bg-slate-100" />}
  </div>
);

const TILE_TINTS = [
  'from-blue-100/70 via-white/50 to-indigo-50/40',
  'from-violet-100/70 via-white/50 to-fuchsia-50/40',
  'from-emerald-100/70 via-white/50 to-teal-50/40',
  'from-amber-100/70 via-white/50 to-orange-50/40',
  'from-sky-100/70 via-white/50 to-cyan-50/40',
  'from-rose-100/70 via-white/50 to-pink-50/40'
];

// Holiday calendar block at the bottom of the Dashboard (both layouts).
const CalendarBlock: React.FC<{ mobile?: boolean }> = ({ mobile }) => (
  <div className={`bg-white/90 border border-slate-200 shadow-sm overflow-hidden ${mobile ? 'rounded-[24px]' : 'rounded-2xl'}`}>
    <div className={`flex items-center justify-between border-b border-slate-100 ${mobile ? 'px-4 py-3' : 'px-6 py-5'}`}>
      <Bar className="h-4 w-36" />
      <Bar className="h-4 w-12 bg-slate-100" />
    </div>
    <div className={`grid grid-cols-7 ${mobile ? 'gap-1.5 p-3' : 'gap-4 p-6'}`}>
      {Array.from({ length: mobile ? 21 : 28 }).map((_, i) => (
        <div key={i} className={`mx-auto rounded bg-slate-100 ${mobile ? 'h-6 w-6' : 'h-8 w-10'}`} />
      ))}
    </div>
  </div>
);

interface Props {
  // Only the cards this account actually gets (UserPanel's own gates).
  showAttendance?: boolean;
  showLeaveSummary?: boolean;
  showTracking?: boolean;
}

export const UserDashboardSkeleton: React.FC<Props> = ({ showAttendance = true, showLeaveSummary = true, showTracking = false }) => (
  <div
    className="relative w-full min-h-[calc(100vh-4rem)] text-slate-900 overflow-hidden animate-pulse"
    role="status"
    aria-label="Loading dashboard"
  >
    {/* ---------- Mobile ---------- */}
    <div className="md:hidden">
      <div className="rounded-b-[28px] shadow-sm" style={{ background: 'var(--g-gradient)' }}>
        <div className="px-6 pt-6 pb-10 flex flex-col items-center gap-2">
          <div className="h-3 w-24 rounded bg-white/40" />
          <div className="h-7 w-44 rounded bg-white/50" />
        </div>
      </div>
      {showAttendance && (
      <div className="relative z-10 px-2 -mt-6 pb-3">
        <div className="rounded-[24px] border border-white/70 p-4 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] bg-gradient-to-br from-blue-200/80 via-white/40 to-indigo-100/60">
          <div className="h-4 w-32 bg-white/70 rounded-md mb-3" />
          <div className="h-9 bg-white/70 rounded-xl mb-2" />
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-white/70 border border-white/50 h-14" />
            <div className="rounded-xl bg-white/70 border border-white/50 h-14" />
          </div>
        </div>
      </div>
      )}
      {showLeaveSummary && (
      <div className={`relative z-10 px-2 pb-3 ${showAttendance ? '' : '-mt-6'}`}>
        <div className="rounded-[28px] overflow-hidden border border-white/70 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] bg-gradient-to-br from-violet-100/70 via-white/50 to-indigo-50/40">
          <div className="px-5 pt-5 pb-8" style={{ background: 'var(--g-gradient)' }}>
            <div className="h-4 w-32 rounded bg-white/50 mb-2" />
            <div className="h-3 w-48 rounded bg-white/35" />
          </div>
          <div className="mx-4 -mt-4 mb-4 rounded-2xl bg-white/90 p-4 space-y-2">
            <div className="h-3 w-24 rounded bg-slate-200" />
            <div className="h-6 w-32 rounded bg-slate-100" />
          </div>
        </div>
      </div>
      )}
      <div className="px-2 pt-4 grid grid-cols-3 gap-x-2 gap-y-4">
        {TILE_TINTS.concat(TILE_TINTS.slice(0, 3)).map((tint, i) => (
          <div key={i} className="flex flex-col items-center gap-1.5">
            <div className={`w-[78px] h-[78px] rounded-[26px] border border-white/70 shadow-[0_10px_24px_-10px_rgba(15,23,42,0.35)] bg-gradient-to-br ${tint} flex items-center justify-center`}>
              <div className="w-11 h-11 rounded-[14px] bg-white/80" />
            </div>
            <div className="h-2.5 w-14 rounded bg-white/80" />
          </div>
        ))}
      </div>
      <div className="px-2 pt-3 pb-32">
        <CalendarBlock mobile />
      </div>
    </div>

    {/* ---------- Web ---------- */}
    <div className="hidden md:block w-full px-6 lg:px-8 pt-3 pb-8 space-y-8">
      <div className="rounded-2xl px-8 py-6 shadow-sm space-y-2.5" style={{ background: 'var(--g-gradient)' }}>
        <div className="h-7 w-64 rounded bg-white/40" />
        <div className="h-3.5 w-[28rem] max-w-full rounded bg-white/30" />
      </div>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {/* My Attendance */}
        {showAttendance && (
        <WhiteCard className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-4 h-4 rounded bg-slate-200" />
            <Bar className="h-4 w-28" />
          </div>
          <div className="h-10 rounded-xl bg-slate-100 mb-4" />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Bar className="h-3 w-14 bg-slate-100" />
              <Bar className="h-3.5 w-20" />
            </div>
            <div className="space-y-2">
              <Bar className="h-3 w-14 bg-slate-100" />
              <Bar className="h-3.5 w-20" />
            </div>
          </div>
          <div className="h-16" />
        </WhiteCard>
        )}

        {/* Leave Summary — violet header, floating white panel */}
        {showLeaveSummary && (
        <WhiteCard>
          <div className="px-6 pt-5 pb-10" style={{ background: 'var(--g-gradient)' }}>
            <div className="h-4 w-36 rounded bg-white/45 mb-2" />
            <div className="h-3 w-44 rounded bg-white/30" />
          </div>
          <div className="mx-6 -mt-5 mb-5 rounded-2xl bg-white border border-slate-100 shadow-sm p-4 space-y-3">
            <Bar className="h-3.5 w-24" />
            <Bar className="h-3 w-40 bg-slate-100" />
            <div className="flex gap-10">
              <div className="space-y-2">
                <Bar className="h-2.5 w-14 bg-slate-100" />
                <Bar className="h-4 w-6" />
              </div>
              <div className="space-y-2">
                <Bar className="h-2.5 w-14 bg-slate-100" />
                <Bar className="h-4 w-6" />
              </div>
            </div>
          </div>
        </WhiteCard>
        )}

        {/* Today */}
        <WhiteCard>
          <CardHeader />
          <div className="p-6 space-y-2.5">
            <Bar className="h-3.5 w-full bg-slate-100" />
            <Bar className="h-3.5 w-2/3 bg-slate-100" />
          </div>
        </WhiteCard>

        {/* Book a Ride */}
        <WhiteCard>
          <CardHeader link />
          <div className="p-5 sm:px-6 space-y-3">
            <div className="h-11 rounded-xl bg-slate-100 border border-slate-200" />
            <Bar className="h-3 w-28 bg-slate-100" />
          </div>
        </WhiteCard>

        {/* My Asset */}
        <WhiteCard>
          <CardHeader link />
          <div className="p-5 sm:px-6 space-y-3">
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-[76px] rounded-xl border border-slate-200 flex flex-col items-center justify-center gap-2">
                  <Bar className="h-4 w-5" />
                  <Bar className="h-2.5 w-14 bg-slate-100" />
                </div>
              ))}
            </div>
            <div className="h-11 rounded-xl bg-slate-100 border border-slate-200" />
          </div>
        </WhiteCard>

        {/* Employee Tracking (tracking module only) */}
        {showTracking && (
          <WhiteCard>
            <CardHeader link />
            <div className="p-5 sm:px-6 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                {[0, 1].map((i) => (
                  <div key={i} className="h-[62px] rounded-xl border border-slate-200 flex flex-col items-center justify-center gap-2">
                    <Bar className="h-4 w-5" />
                    <Bar className="h-2.5 w-20 bg-slate-100" />
                  </div>
                ))}
              </div>
              <Bar className="h-3 w-3/4 bg-slate-100" />
            </div>
          </WhiteCard>
        )}

        {/* My Requests */}
        <WhiteCard className="md:col-span-2 xl:col-span-3">
          <CardHeader />
          <div className="divide-y divide-slate-100">
            {[0, 1].map((i) => (
              <div key={i} className="px-6 py-4 flex items-center gap-3">
                <div className="w-4 h-4 rounded bg-slate-200" />
                <div className="flex-1 space-y-2">
                  <Bar className="h-3.5 w-44" />
                  <Bar className="h-3 w-28 bg-slate-100" />
                </div>
                <div className="space-y-2 flex flex-col items-end">
                  <div className="h-5 w-16 rounded-full bg-slate-100" />
                  <Bar className="h-2.5 w-16 bg-slate-100" />
                </div>
              </div>
            ))}
          </div>
        </WhiteCard>

        {/* Notice Board */}
        <WhiteCard className="md:col-span-2 xl:col-span-3">
          <CardHeader link />
          <div className="px-6 py-4 space-y-2">
            <Bar className="h-3.5 w-32" />
            <Bar className="h-3 w-56 bg-slate-100" />
          </div>
        </WhiteCard>
      </div>
      <CalendarBlock />
    </div>
  </div>
);
