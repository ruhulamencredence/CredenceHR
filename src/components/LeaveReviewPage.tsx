/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { ArrowLeft, CalendarDays, CheckCircle2, XCircle, Clock, Inbox, Plus } from 'lucide-react';
import { LeaveApplication } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { NewLeaveApplicationModal } from './NewLeaveApplicationModal';

interface LeaveReviewPageProps {
  token: string;
  // Same "Back to Menu" pattern MyClaimsCard/ConveyanceClaimCard already use —
  // this page takes over the whole screen (mobile tile-menu section and/or
  // desktop nav target) same as those, so it's always passed here.
  onBack: () => void;
}

// Server-resolved label (LeaveApplication.leave_type_label) covers both the
// 3 fixed Leave types and any custom Leave Category now — falls back to the
// raw leave_type value only for the unlikely case of an old cached record
// that predates this field.
function leaveTypeLabel(a: LeaveApplication): string {
  return a.leave_type_label || a.leave_type;
}

type ReviewTab = 'pending' | 'approved' | 'rejected';

const TABS: { key: ReviewTab; label: string }[] = [
  { key: 'pending', label: 'Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' }
];

// Dashboard -> Leave Summary card -> (tap the card) -> this page. Holds the
// Review/Approved/Rejected tabs + list that used to sit inline on
// LeaveSummaryCard itself — same data (GET /api/leave-applications/mine),
// just moved to its own dedicated page so the Dashboard card can stay to
// just "Leave Summary" / "Submit Leave" / Total Leave. Not Admin-gated, same
// as the card — every account can apply for and review its own Leave.
export const LeaveReviewPage: React.FC<LeaveReviewPageProps> = ({ token, onBack }) => {
  const [applications, setApplications] = useState<LeaveApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<ReviewTab>('pending');
  const [showNewModal, setShowNewModal] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/leave-applications/mine'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setApplications(await res.json());
    } catch {
      // Offline/unreachable — the page just shows whatever it already had (or
      // stays empty); "Submit Leave" still works once connectivity's back.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const filtered = applications.filter((a) => a.status === tab);

  // Counts for each tab's badge — same rounded-number-pill treatment the
  // reference "Expense Summary" design uses on its Review/Approved/Rejected
  // segmented control.
  const countFor = (key: ReviewTab) => applications.filter((a) => a.status === key).length;

  return (
    <>
    {/* Liquid glass on mobile (soft violet-tint gradient + backdrop-blur +
        big rounded corners) — same Dashboard mobile look as Select a
        Budget/Jobs/My Claims/Conveyance Bill Claim. Desktop's md: overrides
        keep the original plain white panel untouched. */}
    <div className="bg-gradient-to-br from-violet-100/70 via-white/50 to-indigo-50/40 backdrop-blur-xl border border-white/70 rounded-[28px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] overflow-hidden md:bg-white md:from-transparent md:via-transparent md:to-transparent md:backdrop-blur-none md:border-slate-200 md:rounded-2xl md:shadow-sm">
      {/* Back to Menu / Submit Leave — desktop only now. Mobile drops the
          on-screen Back button (the header shows this page's own "Leave
          Applications" title in the logo's place, see headerPageTitle.ts in
          UserPanel.tsx, and the native app's hardware/gesture back already
          returns to the tile menu via useBackButtonClose) and moves Submit
          Leave to a floating bottom-right button below, same design/position
          as Movement Claim's "Add Check In/Out" and Conveyance's "New Claim". */}
      <div className="hidden md:flex items-center justify-between gap-3 px-5 pt-4 sm:px-6">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Menu
        </button>
        <button
          type="button"
          onClick={() => setShowNewModal(true)}
          className="flex items-center gap-1 text-xs font-semibold px-3 py-2 rounded-xl text-white transition-colors"
          style={{ background: 'var(--g-accent)' }}
        >
          <Plus className="w-3.5 h-3.5" /> Submit Leave
        </button>
      </div>

      {/* Heading/description hidden on mobile — redundant with the header's
          title takeover. Desktop keeps the full block. */}
      <div className="hidden md:block px-5 pt-4 sm:px-6">
        <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
          <CalendarDays className="w-4 h-4" style={{ color: 'var(--g-accent)' }} /> Leave Applications
        </h3>
        <p className="text-xs text-slate-500 mt-0.5">Review, Approved and Rejected — every Leave Application you've submitted</p>
      </div>

      {/* Review / Approved / Rejected — every submitted Leave Application
          lands in "Review" first; a decision (see Self Service -> Leave
          Approvals) moves it into Approved or Rejected and nowhere else.
          Rounded-pill segmented control (matching the reference "Expense
          Summary" design's Review/Approved/Rejected switcher): a light
          slate-100 track, the active pill fully filled with the app accent
          color + white text + soft shadow, and a small round count badge on
          every pill (white/20-on-accent when active, slate-200-on-slate-500
          when not). */}
      <div className="px-5 sm:px-6 mt-4 md:mt-4 pt-4 md:pt-0 flex items-center gap-1.5 rounded-full bg-white/50 md:bg-slate-100 backdrop-blur md:backdrop-blur-none p-1.5 text-xs font-semibold">
        {TABS.map((t) => {
          const active = tab === t.key;
          const count = countFor(t.key);
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-full transition-colors ${
                active ? 'text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
              style={active ? { background: 'var(--g-accent)' } : undefined}
            >
              {t.label}
              <span
                className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold ${
                  active ? 'bg-white/25 text-white' : 'bg-slate-200 text-slate-500'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <div className="px-5 sm:px-6 py-4">
        {loading ? (
          <p className="text-xs text-slate-400 text-center py-8">Loading Leave Applications...</p>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 text-center py-8 text-slate-400">
            <Inbox className="w-6 h-6 text-slate-300" />
            <p className="text-xs font-semibold text-slate-500">
              {tab === 'pending' ? 'Nothing waiting on review.' : tab === 'approved' ? 'No approved Leave yet.' : 'No rejected Leave.'}
            </p>
            {tab === 'pending' && (
              <p className="text-[11px] text-slate-400 max-w-[220px]">
                Ready for some time off? Tap "Submit Leave" to apply.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((a) => (
              // No backdrop-blur on these cards on purpose — a per-item blur
              // layer for every application in the list is what made other
              // pages (Employee Directory, Job Entry Details) stutter on
              // Android. A plain, more opaque white keeps the same glass
              // look without that per-item cost.
              <div key={a.id} className="border border-white/60 md:border-slate-200 rounded-2xl md:rounded-xl bg-white/80 md:bg-white p-3.5">
                <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                  <CalendarDays className="w-3.5 h-3.5" style={{ color: 'var(--g-accent)' }} />
                  {formatDate(a.apply_date)}
                </div>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-slate-400">
                      {leaveTypeLabel(a)}
                    </p>
                    <p className="font-semibold text-slate-700 mt-0.5">
                      {formatDate(a.start_date)} – {formatDate(a.end_date)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] uppercase tracking-wide text-slate-400">Total Leave</p>
                    <p className="font-semibold text-slate-700 mt-0.5">
                      {a.day_count} {a.day_count === 1 ? 'Day' : 'Days'}
                    </p>
                  </div>
                </div>
                {a.status === 'pending' ? (
                  <div className="mt-2.5 pt-2.5 border-t border-slate-100 flex items-center gap-1.5 text-[11px] text-amber-700">
                    <Clock className="w-3 h-3" /> Awaiting approval{a.approver_name ? ` from ${a.approver_name}` : ''}
                    {a.total_steps ? <span className="text-amber-500">&nbsp;(Layer {a.current_step} of {a.total_steps})</span> : null}
                  </div>
                ) : (
                  <div className="mt-2.5 pt-2.5 border-t border-slate-100 flex items-center justify-between gap-2">
                    <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                      a.status === 'approved' ? 'text-emerald-700' : 'text-rose-600'
                    }`}>
                      {a.status === 'approved' ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                      {a.status === 'approved' ? 'Approved' : 'Rejected'}{a.decided_at ? ` at ${formatDate(a.decided_at)}` : ''}
                    </span>
                    {a.decided_by_name && <span className="text-[11px] text-slate-500 shrink-0">By {a.decided_by_name}</span>}
                  </div>
                )}
                {a.status === 'rejected' && a.remarks && (
                  <div className="mt-1.5 text-[11px] text-slate-500">
                    <span className="font-medium text-slate-600">Reason:</span> {a.remarks}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

    </div>

      {/* Floating "Submit Leave" — mobile only, same design/position/color as
          Movement Claim's "Add Check In/Out" and Conveyance's "New Claim"
          floating buttons (bottom-right, above BottomNav's fixed bar). */}
      <button
        type="button"
        onClick={() => setShowNewModal(true)}
        className="md:hidden fixed right-4 z-50 flex items-center gap-2 pl-4 pr-5 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-full shadow-lg shadow-blue-600/30 active:scale-95 transition-transform"
        style={{ bottom: 'calc(6.5rem + env(safe-area-inset-bottom, 0px))' }}
      >
        <Plus className="w-4 h-4" /> Submit Leave
      </button>

      {showNewModal && (
        <NewLeaveApplicationModal
          token={token}
          onClose={() => setShowNewModal(false)}
          onSubmitted={() => {
            setShowNewModal(false);
            load();
          }}
        />
      )}
    </>
  );
};
