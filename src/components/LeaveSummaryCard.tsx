/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { CalendarDays } from 'lucide-react';
import { Lottie } from 'lottie-react';
import { LeaveApplication, LeaveBalance } from '../types';
import { apiUrl, dedupedFetchJson } from '../lib/api';
import beachAnimation from '../assets/Beach.json';

interface LeaveSummaryCardProps {
  token: string;
  // Opens the full Review/Approved/Rejected page (LeaveReviewPage) — same
  // "tap the summary tile to drill into its own page" pattern the Conveyance
  // Bill Claim tile already uses, just triggered by tapping this card instead
  // of a Dashboard tile-menu icon.
  onOpen: () => void;
}

// Dashboard-only compact version of the old all-in-one Leave Summary card:
// still every account's own Leave Applications (not Admin-gated, same data
// as "Self Service -> Leave Application"), but now trimmed down to just the
// violet header ("Leave Summary" + a decorative Lottie badge) and the Total
// Leave (Available/Used) strip. Submit Leave now lives only on
// LeaveReviewPage (opened via onOpen), so this card doesn't need its own
// "Submit Leave" button or <NewLeaveApplicationModal> anymore. The
// Review/Approved/Rejected tabs + list that used to sit inline here also
// live in LeaveReviewPage — mirrors how the Conveyance Bill Claim tile
// summarizes on the Dashboard and opens its own dedicated page for the rest.
export const LeaveSummaryCard: React.FC<LeaveSummaryCardProps> = ({ token, onOpen }) => {
  // backdrop-filter is real bug material on the Android system WebView
  // (small GPU raster budget, every blur layer fights for it) — that's why
  // this strip could render blurred on one reload and flat on the next. A
  // JS-side repaint nudge was tried first and didn't hold up, because the
  // failure is hardware/driver-level, not something JS can force. Dropping
  // backdrop-blur-xl for the native app build removes the failure mode
  // instead of chasing it, and costs nothing visually — see the note further
  // down on what actually sells "glass" here.
  const isNativeApp = Capacitor.isNativePlatform();
  const [applications, setApplications] = useState<LeaveApplication[]>([]);
  const [balance, setBalance] = useState<LeaveBalance | null>(null);

  const load = async () => {
    try {
      // This card mounts twice on every Dashboard load (mobile + desktop
      // copies, see UserPanel.tsx) — dedupedFetchJson means only one of the
      // two actually hits the network.
      const [apps, rows] = await Promise.all([
        dedupedFetchJson(apiUrl('/api/leave-applications/mine'), token),
        dedupedFetchJson(apiUrl('/api/leave-balances/mine'), token)
      ]);
      if (apps) setApplications(apps);
      if (rows) setBalance(Array.isArray(rows) && rows.length > 0 ? rows[0] : null);
    } catch {
      // Offline/unreachable — the card just shows whatever it already had (or
      // stays empty).
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // "Available" mirrors the remaining balance across all three Leave types —
  // rejections already refund their day_count server-side (see decision
  // endpoint), so this always reflects what's actually left to spend right
  // now. "Leave Used" is everything currently deducted against that — i.e.
  // every application NOT rejected, pending included, since day_count is
  // taken out of the balance the moment it's submitted, before any decision.
  const available = balance ? balance.casual_leave + balance.sick_leave + balance.leave_without_pay : 0;
  const used = applications.filter((a) => a.status !== 'rejected').reduce((sum, a) => sum + a.day_count, 0);

  const year = new Date().getFullYear();

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onOpen();
        }}
        // Liquid glass on mobile like the rest of that Dashboard; plain white
        // from md up so it matches the other cards in the desktop Dashboard
        // grid (see the same note on AttendanceCard). The violet header
        // inside stays either way — that's this card's own identity, not the
        // mobile surface treatment.
        className="glass-mask-fix relative rounded-[28px] overflow-hidden border border-white/70 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] bg-gradient-to-br from-violet-100/70 via-white/50 to-indigo-50/40 text-left cursor-pointer hover:shadow-lg hover:border-white transition-all md:bg-white md:from-transparent md:via-transparent md:to-transparent md:border-slate-200 md:rounded-2xl md:shadow-sm"
      >
      {/* No backdrop-blur on this outer shell (there used to be one, split
          onto its own absolutely-positioned -z-10 child layer to work
          around an Android compositor gap) — confirmed on real hardware
          that this device's WebView doesn't render backdrop-filter at all,
          so that layer was dead weight, and the negative-z-index child was
          the likely cause of a separate bug where the card's background
          would render correctly on first paint and then disappear after a
          reload.
          That reload bug, it turns out, wasn't really about the -z-10 child
          at all — it's a broader Android/WebKit rounded-corner +
          translucent-background compositor bug (see glass-mask-fix in
          index.css), and it can hit this shell's own rounded gradient
          background too, blur or no blur, hence glass-mask-fix being
          applied here as well now. The "Total Leave" strip below doesn't
          depend on blur to read as a distinct panel — see the note on it
          further down. */}
      {/* Violet gradient header — same drop-notch corner treatment as the
          mobile Dashboard banner (rounded-b on this card's own top instead,
          since it sits inline among other cards rather than at the very top
          of the screen). Submit Leave now lives on LeaveReviewPage only, so
          this header is just the title/subtitle plus a decorative Lottie
          badge in the top-right corner (pointer-events-none — purely
          visual, so it never blocks the card's onOpen tap target). */}
      <div className="px-5 pt-5 pb-6 sm:px-6 text-white" style={{ background: 'var(--g-gradient)' }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold flex items-center gap-2">
              <CalendarDays className="w-4 h-4" /> Leave Summary
            </h3>
            <p className="text-xs text-white/70 mt-0.5">Your Leave balance and review status</p>
          </div>
          <div className="shrink-0 w-20 h-20 -mt-2 -mr-1 pointer-events-none">
            <Lottie src={beachAnimation} autoplay loop className="w-full h-full" />
          </div>
        </div>
      </div>

      {/* Total Leave strip — overlaps the header the same way AttendanceCard
          overlaps the Dashboard banner, so this reads as one connected card.
          backdrop-blur-xl is close to invisible here on its own, since the
          violet header right behind this strip is a flat gradient with no
          texture to blur — the bright inset top-edge highlight below (same
          trick the floating action buttons use) is what mainly sells
          "glass" on this screen. bg-white/75: /50 read as a washed-out
          purple smear (no separation from the header); /95 swung the other
          way — flat opaque white, no glass feel. /75 is the middle ground.
          Which is why it's dropped outright for the native app below: it
          wasn't buying much visually, but real Android hardware could
          render it on one reload and silently lose it on the next.
          glass-mask-fix (index.css) covers the broader version of that same
          bug for this strip's own rounded translucent background,
          independent of whether blur is present at all. */}
      <div className="px-5 sm:px-6 -mt-4 pb-5">
        <div
          style={{ transform: 'translateZ(0)', WebkitTransform: 'translateZ(0)' }}
          className={`glass-mask-fix bg-white/75 border border-white/60 rounded-2xl px-5 py-2.5 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15),inset_0_1px_0_rgba(255,255,255,0.6)] ${isNativeApp ? '' : 'backdrop-blur-xl'}`}
        >
          <p className="text-xs font-bold text-slate-900">Total Leave</p>
          <p className="text-[11px] text-slate-500 mt-0.5">Period 1 Jan {year} – 31 Dec {year}</p>
          <div className="mt-1.5 flex items-center gap-6">
            <div>
              <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <span className="w-2 h-2 rounded-full bg-emerald-500" /> Available
              </div>
              <p className="text-lg font-bold text-slate-900 mt-0.5">{available}</p>
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--g-accent)' }} /> Leave Used
              </div>
              <p className="text-lg font-bold text-slate-900 mt-0.5">{used}</p>
            </div>
          </div>
        </div>
      </div>
      </div>
    </>
  );
};