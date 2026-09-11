/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { Lottie } from 'lottie-react';
import { LeaveApplication, LeaveBalance } from '../types';
import { apiUrl } from '../lib/api';
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
  const [applications, setApplications] = useState<LeaveApplication[]>([]);
  const [balance, setBalance] = useState<LeaveBalance | null>(null);

  const load = async () => {
    try {
      const [appsRes, balRes] = await Promise.all([
        fetch(apiUrl('/api/leave-applications/mine'), { headers: { Authorization: `Bearer ${token}` } }),
        fetch(apiUrl('/api/leave-balances/mine'), { headers: { Authorization: `Bearer ${token}` } })
      ]);
      if (appsRes.ok) setApplications(await appsRes.json());
      if (balRes.ok) {
        const rows = await balRes.json();
        setBalance(Array.isArray(rows) && rows.length > 0 ? rows[0] : null);
      }
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
        className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden text-left cursor-pointer hover:shadow-md transition-shadow"
      >
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
          overlaps the Dashboard banner, so this reads as one connected card. */}
      <div className="px-5 sm:px-6 -mt-4 pb-5">
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm">
          <p className="text-xs font-bold text-slate-900">Total Leave</p>
          <p className="text-[11px] text-slate-500 mt-0.5">Period 1 Jan {year} – 31 Dec {year}</p>
          <div className="mt-2.5 flex items-center gap-6">
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