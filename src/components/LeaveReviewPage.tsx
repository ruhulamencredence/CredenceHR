/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useLiveRefresh } from '../lib/liveRefresh';
import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CalendarDays, CheckCircle2, XCircle, Clock, Inbox, Plus } from 'lucide-react';
import { LeaveApplication, LeaveBalance } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { NewLeaveApplicationModal } from './NewLeaveApplicationModal';
import { useIsPhone } from './TimesheetPhone';
import { LeaveGauge, LeavePhoneCard, LeaveTypeInfo, leaveTypeStyle } from './LeavePhone';

interface LeaveReviewPageProps {
  token: string;
  // Same "Back to Menu" pattern MyClaimsCard/ConveyanceClaimCard already use —
  // this page takes over the whole screen (mobile tile-menu section and/or
  // desktop nav target) same as those, so it's always passed here.
  onBack: () => void;
  // False while the phone's bottom nav keeps this page mounted but hidden.
  active?: boolean;
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

// Dashboard -> Leave Summary card -> (tap the card) -> this page, and also
// GlobalSidebar's single "Leave Application" item (Self Service -> My HR ->
// Leave Manage). Holds the Review/Approved/Rejected tabs + list that used to
// sit inline on LeaveSummaryCard itself — same data (GET
// /api/leave-applications/mine), just moved to its own dedicated page so the
// Dashboard card can stay to just "Leave Summary" / "Submit Leave" / Total
// Leave. Not Admin-gated, same as the card — every account can apply for and
// review its own Leave. Also shows this account's own Leave balance (Casual/
// Sick/Leave-without-Pay + custom categories) — merged in from the old
// separate "My Leave" page (MyLeave.tsx, now deleted) so there's one
// "Leave Application" interface instead of two.
export const LeaveReviewPage: React.FC<LeaveReviewPageProps> = ({ token, onBack, active = true }) => {
  const [applications, setApplications] = useState<LeaveApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<ReviewTab>('pending');
  const [showNewModal, setShowNewModal] = useState(false);

  // Own Leave balance (Casual/Sick/Leave-without-Pay + any custom Leave
  // Categories) — merged in from the old standalone "My Leave" page/menu
  // item (MyLeave.tsx, now deleted), so this one "Leave Application" page
  // covers both applying/reviewing AND checking your own balance, read-only.
  // Same /api/leave-balances/mine endpoint (always this account's own single
  // row, even for a Leave Manager/Superadmin) MyLeave.tsx used.
  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(true);

// Live refresh: reload when a request changes (src/lib/liveRefresh.ts).
useLiveRefresh(() => load(true));
  const load = async (silent?: unknown) => {
    if (silent !== true) setLoading(true);
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

  const loadBalance = async (silent?: boolean) => {
    if (!silent) setBalanceLoading(true);
    try {
      const res = await fetch(apiUrl('/api/leave-balances/mine'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const rows: LeaveBalance[] = await res.json();
        setBalance(Array.isArray(rows) ? rows[0] || null : null);
      }
    } catch {
      // Offline/unreachable — balance strip just stays empty; the rest of
      // the page (submit/review) still works.
    } finally {
      setBalanceLoading(false);
    }
  };

  useEffect(() => {
    load();
    loadBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Shown again (the phone's bottom nav keeps this page mounted): keep what
  // it has on screen and bring it up to date quietly.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) {
      load(true);
      loadBalance(true);
    }
    wasActive.current = active;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const filtered = applications.filter((a) => a.status === tab);

  // Counts for each tab's badge — same rounded-number-pill treatment the
  // reference "Expense Summary" design uses on its Review/Approved/Rejected
  // segmented control.
  const countFor = (key: ReviewTab) => applications.filter((a) => a.status === key).length;

  // Phone layout (LeavePhone.tsx): always this calendar year — a gauge of
  // days left / taken per leave type, whose type buttons filter the list.
  const isPhone = useIsPhone();
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const thisYear = new Date().getFullYear();
  const inThisYear = (a: LeaveApplication) =>
    a.status === 'pending' || Number(String(a.start_date).slice(0, 4)) === thisYear || Number(String(a.end_date).slice(0, 4)) === thisYear;
  const takenThisYear = (key: string) =>
    applications
      .filter((a) => a.leave_type === key && a.status === 'approved' && Number(String(a.start_date).slice(0, 4)) === thisYear)
      .reduce((n, a) => n + Number(a.day_count || 0), 0);
  const leaveTypes: LeaveTypeInfo[] = balance
    ? [
        { key: 'casual', label: 'Casual leave', short: 'Casual', left: Number(balance.casual_leave), taken: takenThisYear('casual') },
        { key: 'sick', label: 'Sick leave', short: 'Sick', left: Number(balance.sick_leave), taken: takenThisYear('sick') },
        { key: 'without_pay', label: 'Leave without pay', short: 'No pay', left: null, taken: takenThisYear('without_pay') },
        ...(balance.custom_leaves || []).map((c) => ({
          key: c.key,
          label: c.label,
          short: c.label.replace(/\s+leave$/i, ''),
          left: Number(c.balance),
          taken: takenThisYear(c.key)
        }))
      ]
    : [];
  const typeKeys = leaveTypes.map((t) => t.key);
  const phoneApps = applications
    .filter((a) => inThisYear(a) && (!typeFilter || a.leave_type === typeFilter))
    .sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)) || Number(b.id) - Number(a.id));
  const phoneCount = (key: ReviewTab) => phoneApps.filter((a) => a.status === key).length;

  return (
    <>
    {isPhone ? (
      <div className="flex flex-col gap-3 px-1 pt-1 pb-8">
        {!balanceLoading && leaveTypes.length === 0 && (
          <button type="button" onClick={() => setShowNewModal(true)} className="liquid-glass-button w-full min-h-[46px] rounded-full text-sm font-extrabold flex items-center justify-center gap-1.5">
            <Plus className="w-4 h-4" /> Submit leave
          </button>
        )}
        {balanceLoading ? null : leaveTypes.length > 0 && (
          <LeaveGauge types={leaveTypes} year={thisYear} filter={typeFilter} onFilter={setTypeFilter} onSubmit={() => setShowNewModal(true)} />
        )}
        <div className="liquid-glass-inset grid grid-cols-3 gap-1 p-1 rounded-full">
          {TABS.map((t) => {
            const on = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                aria-pressed={on}
                onClick={() => setTab(t.key)}
                className={`min-h-[38px] rounded-full text-[13px] font-bold flex items-center justify-center gap-1.5 transition-colors ${
                  on ? 'bg-white/95 text-[color:var(--g-accent,#7f00ff)] shadow-sm' : 'text-zinc-600'
                }`}
              >
                {t.label}
                <span
                  className={`min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-extrabold inline-flex items-center justify-center ${
                    on ? 'bg-[color:color-mix(in_srgb,var(--g-accent,#7f00ff)_12%,transparent)]' : 'bg-slate-900/[.06]'
                  }`}
                >
                  {phoneCount(t.key)}
                </span>
              </button>
            );
          })}
        </div>
        {loading ? (
          <p className="text-xs text-slate-400 text-center py-8">Loading Leave Applications...</p>
        ) : phoneApps.filter((a) => a.status === tab).length === 0 ? (
          <div className="liquid-glass rounded-[22px] p-6 text-center text-[13px] text-zinc-500">
            {tab === 'pending' ? 'Nothing waiting on review.' : tab === 'approved' ? 'No approved leave here.' : 'No rejected leave.'}
            {tab === 'pending' && !typeFilter && <p className="mt-1 text-xs text-zinc-400">Ready for some time off? Tap "Submit leave".</p>}
          </div>
        ) : (
          phoneApps
            .filter((a) => a.status === tab)
            .map((a) => <LeavePhoneCard key={a.id} app={a} typeLabel={leaveTypeLabel(a)} style={leaveTypeStyle(a.leave_type, typeKeys)} />)
        )}
      </div>
    ) : (
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

      {/* Own Leave balance — merged in from the old standalone "My Leave"
          page (see the balance state/loadBalance above). Shown on both
          mobile and desktop, ahead of the Review/Approved/Rejected switcher,
          so "how much do I have left" is the first thing this page answers
          before "what have I already submitted". Read-only, no per-account
          table, no editing — same scope MyLeave.tsx always had. */}
      {!balanceLoading && balance && (
        <div className="px-4 sm:px-6 pt-4 flex flex-wrap gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 border border-blue-100">
            Casual <span className="font-bold">{balance.casual_leave}</span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100">
            Sick <span className="font-bold">{balance.sick_leave}</span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-full bg-amber-50 text-amber-700 border border-amber-100">
            Without Pay <span className="font-bold">{balance.leave_without_pay}</span>
          </div>
          {balance.custom_leaves?.map((c) => (
            <div key={c.key} className="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-full bg-violet-50 text-violet-700 border border-violet-100">
              {c.label} <span className="font-bold">{c.balance}</span>
            </div>
          ))}
        </div>
      )}

      {/* Review / Approved / Rejected — mobile only now (see the desktop
          table below, which shows every status at once via its own Status
          column instead, same as Admin Panel -> HR -> "Monthly Leave
          Application" has no tabs either). Every submitted Leave Application
          lands in "Review" first; a decision (see Self Service -> Leave
          Approvals) moves it into Approved or Rejected and nowhere else.
          Same rounded-pill segmented control as Conveyance Bill Claim's
          Review/Approved/Rejected switcher (identical padding/height/colors)
          so the two pages read as the same component: a light slate-100
          track, the active pill fully filled with indigo-600 + white text +
          soft shadow, and a small round count badge on every pill
          (white/25%-on-indigo when active, slate-200-on-slate-500 when not). */}
      <div className="md:hidden px-4 sm:px-6 mt-4 pt-4 pb-1">
        <div className="flex items-center gap-1.5 rounded-full bg-white/50 backdrop-blur p-1 text-xs font-semibold">
          {TABS.map((t) => {
            const active = tab === t.key;
            const count = countFor(t.key);
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-full transition-colors ${
                  active ? 'text-white shadow-sm bg-indigo-600' : 'text-slate-500 hover:text-slate-700'
                }`}
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
      </div>

      {/* Desktop — a real table, every status at once (Applied On newest
          first), same layout/columns/status-pill styling as Admin Panel ->
          HR -> "Monthly Leave Application" (minus Employee/Department,
          redundant here since this page is always just the signed-in
          account's own applications). No tabs — the Status column already
          shows Review/Approved/Rejected per row. */}
      <div className="hidden md:block">
        {loading ? (
          <p className="text-xs text-slate-400 text-center py-8">Loading Leave Applications...</p>
        ) : applications.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-slate-400">No Leave Applications found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3">Applied On</th>
                  <th className="px-4 py-3">Leave Type</th>
                  <th className="px-4 py-3">Start Date</th>
                  <th className="px-4 py-3">End Date</th>
                  <th className="px-4 py-3">Days</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Approver / Decided By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {[...applications]
                  .sort((a, b) => Number(b.id) - Number(a.id))
                  .map((a) => (
                    <tr key={a.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-900">{formatDate(a.apply_date)}</td>
                      <td className="px-4 py-3 text-slate-600">{leaveTypeLabel(a)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatDate(a.start_date)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatDate(a.end_date)}</td>
                      <td className="px-4 py-3 text-slate-600">{a.day_count}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                          a.status === 'approved' ? 'bg-emerald-50 text-emerald-700' :
                          a.status === 'rejected' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'
                        }`}>
                          {a.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {a.status === 'pending' ? (a.no_approver ? 'No approver set yet' : a.approver_name || '—') : (a.decided_by_name || '—')}
                        {a.status === 'rejected' && a.remarks && (
                          <span className="block text-[11px] text-slate-400 mt-0.5">Reason: {a.remarks}</span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Mobile — the original Liquid Glass card list, untouched (still
          tab-filtered by Review/Approved/Rejected above). */}
      <div className="md:hidden">
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
          <div className="px-5 sm:px-6 py-4 space-y-3">
            {filtered.map((a) => (
              // No backdrop-blur on these cards on purpose — a per-item blur
              // layer for every application in the list is what made other
              // pages (Employee Directory, Job Entry Details) stutter on
              // Android. A plain, more opaque white keeps the same glass
              // look without that per-item cost.
              <div key={a.id} className="border border-white/60 rounded-2xl bg-white/80 p-3.5">
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
                    <Clock className="w-3 h-3" /> {a.no_approver ? 'No approver set yet — tell HR' : `Awaiting approval${a.approver_name ? ` from ${a.approver_name}` : ''}`}
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
    </>
    )}

      {/* On a phone, Submit leave sits in the gauge card (LeavePhone.tsx);
          desktop has it in the header row above. */}
      {showNewModal && (
        <NewLeaveApplicationModal
          token={token}
          onClose={() => setShowNewModal(false)}
          onSubmitted={() => {
            setShowNewModal(false);
            load();
            loadBalance();
          }}
        />
      )}
    </>
  );
};
